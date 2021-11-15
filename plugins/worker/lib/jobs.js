'use strict';

const amqp = require('amqp-connection-manager');
const Redis = require('ioredis');
const config = require('config');
const hoek = require('@hapi/hoek');
const ExecutorRouter = require('screwdriver-executor-router');
const logger = require('screwdriver-logger');
const producer = require('screwdriver-aws-producer-service');
const { BlockedBy } = require('./BlockedBy');
const { Filter } = require('./Filter');
const { CacheFilter } = require('./CacheFilter');
const blockedByConfig = config.get('plugins').blockedBy;
const { connectionDetails, queuePrefix, runningJobsPrefix, waitingJobsPrefix } = require('../../../config/redis');
const rabbitmqConf = require('../../../config/rabbitmq');
const { amqpURI, exchange, connectOptions } = rabbitmqConf.getConfig();
const kafkaEnabled = config.get('kafka').enabled === 'true';

const RETRY_LIMIT = 3;
// This is in milliseconds, reference: https://github.com/taskrabbit/node-resque/blob/master/lib/plugins/Retry.js#L12
const RETRY_DELAY = 5 * 1000;
const redis = new Redis(connectionDetails.port, connectionDetails.host, connectionDetails.options);

const ecosystem = config.get('ecosystem');
const executorConfig = config.get('executor');

const executorPlugins = Object.keys(executorConfig).reduce((aggregator, keyName) => {
    if (keyName !== 'plugin') {
        aggregator.push({
            name: keyName,
            ...executorConfig[keyName]
        });
    }

    return aggregator;
}, []);

const executor = new ExecutorRouter({
    defaultPlugin: executorConfig.plugin,
    executor: executorPlugins,
    ecosystem
});
const retryOptions = {
    retryLimit: RETRY_LIMIT,
    retryDelay: RETRY_DELAY
};
const blockedByOptions = {
    // TTL of key, same value as build timeout so that
    // blocked job is not stuck forever in the case cleanup failed to run
    blockTimeout: blockedByConfig.blockTimeout,

    // Time to reEnqueue
    reenqueueWaitTime: blockedByConfig.reenqueueWaitTime,

    blockedBySelf: blockedByConfig.blockedBySelf,

    collapse: blockedByConfig.collapse
};
let rabbitmqConn;

/**
 * Get Rabbitmq connection, if it exists reuse it, otherwise create it
 * @method getRabbitmqConn
 * @return {Promise}
 */
function getRabbitmqConn() {
    logger.info('Getting rabbitmq connection.');

    if (rabbitmqConn) {
        return rabbitmqConn;
    }

    rabbitmqConn = amqp.connect([amqpURI], connectOptions);
    logger.info('Creating new rabbitmq connection.');

    rabbitmqConn.on('connect', () => logger.info('Connected to rabbitmq!'));
    rabbitmqConn.on('disconnect', params => logger.info(`Disconnected from rabbitmq: ${params.err.stack}`));

    return rabbitmqConn;
}

/**
 * Pushes a message to rabbitmq
 * @param {Object} message
 * @param {String} queue
 * @param {String} messageId
 */
async function pushToRabbitMq(message, queue, messageId) {
    if (!rabbitmqConf.getConfig().schedulerMode) {
        return Promise.resolve();
    }

    const conn = getRabbitmqConn();
    const channelWrapper = conn.createChannel({
        json: true,
        setup: channel => channel.checkExchange(exchange)
    });

    logger.info('publishing msg to rabbitmq: %s', messageId);

    channelWrapper.on('error', (error, { name }) => {
        logger.error(`channel wrapper error ${error}:${name}`);
    });

    return channelWrapper
        .publish(exchange, queue, message, {
            contentType: 'application/json',
            persistent: true
        })
        .then(() => {
            logger.info('successfully publishing msg id %s -> queue %s', messageId, queue);

            return channelWrapper.close();
        })
        .catch(err => {
            logger.error('publishing failed to rabbitmq: %s', err.message);
            channelWrapper.close();
            conn.close();
            throw err;
        });
}

/**
 *
 * @param {Object} message
 * @param {String} topic
 */
async function pushToKafka(message, topic) {
    const conn = await producer.connect();

    if (conn) {
        await producer.sendMessage(message, topic);
    }
}

/**
 * Schedule a job based on mode
 * @method schedule
 * @param  {String} job         job name, either start or stop
 * @param  {Object} buildConfig build config
 * @return {Promise}
 */
async function schedule(job, buildConfig) {
    const buildCluster = buildConfig.buildClusterName;

    delete buildConfig.buildClusterName;

    const msg = {
        job,
        buildConfig
    };

    if (kafkaEnabled && buildConfig.provider) {
        const { accountId, region } = buildConfig.provider;
        const topic = `builds-${accountId}-${region}`;

        return pushToKafka(msg, topic);
    }

    if (rabbitmqConf.getConfig().schedulerMode) {
        try {
            return await pushToRabbitMq(msg, buildCluster, buildConfig.buildId);
        } catch (err) {
            logger.error(`err in pushing to rabbitmq: ${err}`);
            throw err;
        }
    }

    // token is not allowed in executor.stop
    if (job === 'stop') {
        delete buildConfig.token;
    }

    return executor[job](buildConfig);
}

/**
 * Call executor.start with the buildConfig obtained from the redis database
 * @method start
 * @param  {Object}    buildConfig               Configuration object
 * @param  {String}    buildConfig.buildId       Unique ID for a build
 * @param  {String}    buildConfig.jobId         Job that this build belongs to
 * @param  {String}    buildConfig.blockedBy     Jobs that are blocking this job
 * @return {Promise}
 */
async function start(buildConfig) {
    try {
        const fullBuildConfig = await redis.hget(`${queuePrefix}buildConfigs`, buildConfig.buildId);

        await schedule('start', JSON.parse(fullBuildConfig));

        return null;
    } catch (err) {
        logger.error(`err in start job: ${err}`);
        throw err;
    }
}

/**
 * Call executor.stop with the buildConfig
 * @method stop
 * @param  {Object}    buildConfig               Configuration object
 * @param  {String}    buildConfig.buildId       Unique ID for a build
 * @param  {String}    buildConfig.jobId         Job that this build belongs to
 * @param  {String}    buildConfig.blockedBy     Jobs that are blocking this job
 * @param  {String}    buildConfig.started       Whether job has started
 * @param  {String}    buildConfig.jobName    Job name
 * @return {Promise}
 */
async function stop(buildConfig) {
    const started = hoek.reach(buildConfig, 'started', { default: true }); // default value for backward compatibility
    const { buildId, jobId, jobName } = buildConfig;
    let stopConfig = { buildId, jobId, jobName };
    const runningKey = `${runningJobsPrefix}${jobId}`;

    try {
        const fullBuildConfig = await redis.hget(`${queuePrefix}buildConfigs`, buildId);
        const parsedConfig = JSON.parse(fullBuildConfig);

        if (parsedConfig) {
            stopConfig = {
                buildId,
                ...parsedConfig
            };
        }
    } catch (err) {
        logger.error(`[Stop Build] failed to get config for build ${buildId}: ${err.message}`);
    }

    await redis.hdel(`${queuePrefix}buildConfigs`, buildId);
    // If this is a running job
    const runningBuildId = await redis.get(runningKey);

    if (parseInt(runningBuildId, 10) === buildId) {
        await redis.del(runningKey);
    }
    // If this is a waiting job
    await redis.lrem(`${waitingJobsPrefix}${jobId}`, 0, buildId);

    if (started) {
        await schedule('stop', stopConfig);
    }

    return null;
}

/**
 * Send message to clear cache from disk
 * @param {Object} cacheConfig
 */
async function clear(cacheConfig) {
    const { id, buildClusters } = cacheConfig;
    const data = await redis.hget(`${queuePrefix}buildConfigs`, id);

    if (data) {
        const buildConfig = JSON.parse(data);

        const queueName = buildConfig.buildClusterName;

        if (queueName) {
            await pushToRabbitMq({ job: 'clear', cacheConfig }, queueName, id);
        }
    }

    if (buildClusters) {
        await Promise.all(
            buildClusters.map(async cluster => {
                return pushToRabbitMq({ job: 'clear', cacheConfig }, cluster, id);
            })
        );
    }

    return null;
}

module.exports = {
    start: {
        plugins: [Filter, 'Retry', BlockedBy],
        pluginOptions: {
            Retry: retryOptions,
            BlockedBy: blockedByOptions
        },
        perform: start
    },
    stop: {
        plugins: [Filter, 'Retry'], // stop shouldn't use blockedBy
        pluginOptions: {
            Retry: retryOptions
        },
        perform: stop
    },
    clear: {
        plugins: [CacheFilter, 'Retry'],
        pluginOptions: {
            Retry: retryOptions
        },
        perform: clear
    }
};
