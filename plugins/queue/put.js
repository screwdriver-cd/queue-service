'use strict';

const logger = require('screwdriver-logger');
const { merge, reach } = require('@hapi/hoek');
const cron = require('./utils/cron');
const Resque = require('node-resque');
const helper = require('../helper');
const { timeOutOfWindows } = require('./utils/freezeWindows');
const DEFAULT_BUILD_TIMEOUT = 90;
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;

/**
 * Posts a new build event to the API
 * @method postBuildEvent
 * @param {Object} config           Configuration
 * @param {Number} [config.eventId] Optional Parent event ID (optional)
 * @param {Object} config.pipeline  Pipeline of the job
 * @param {Object} config.job       Job object to create periodic builds for
 * @param {String} config.apiUri    Base URL of the Screwdriver API
 * @return {Promise}
 */
async function postBuildEvent(executor, { pipeline, job, apiUri, eventId, buildId, causeMessage }) {
    const admin = await helper.getPipelineAdmin(
        { redisBreaker: executor.redisBreaker, buildId },
        apiUri,
        pipeline.id, executor.requestRetryStrategy);

    logger.info(`POST event for pipeline ${pipeline.id}:${job.name} using user ${admin.username}`);

    const buildEvent = {
        pipelineId: pipeline.id,
        startFrom: job.name,
        creator: {
            name: 'Screwdriver scheduler',
            username: 'sd:scheduler'
        },
        causeMessage: causeMessage || 'Automatically started by scheduler'
    };

    if (eventId) {
        buildEvent.parentEventId = eventId;
    }
    await helper.createBuildEvent(
        apiUri,
        { redisBreaker: executor.redisBreaker, buildId },
        buildEvent,
        executor.requestRetryStrategy
    );
}

/**
 * Stops a previously enqueued frozen build in an executor
 * @async  stopFrozen
 * @param  {Object}  config        Configuration
 * @param  {Integer} config.jobId  ID of the job with frozen builds
 * @return {Promise}
 */
async function stopFrozen(executor, config) {
    await executor.connect();

    await executor.queueBreaker.runCommand('delDelayed', executor.frozenBuildQueue, 'startFrozen',
        [{
            jobId: config.jobId
        }]);

    return executor.redisBreaker.runCommand('hdel', executor.frozenBuildTable, config.jobId);
}

/**
 * Calls postBuildEvent() with job configuration
 * @async startFrozen
 * @param {Object} config       Configuration
 * @return {Promise}
 */
async function startFrozen(executor, config) {
    try {
        const newConfig = {
            job: {
                name: config.jobName
            },
            causeMessage: 'Started by freeze window scheduler'
        };

        if (config.jobState === 'DISABLED' || config.jobArchived === true) {
            logger.error(`job ${config.jobName} is disabled or archived`);

            return Promise.resolve();
        }

        Object.assign(newConfig, config);

        return await postBuildEvent(executor, newConfig);
    } catch (err) {
        logger.error('frozen builds: failed to post build event for job'
            + `${config.jobId}:${config.pipeline.id} ${err}`);

        return Promise.resolve();
    }
}

/**
* Stops a previously scheduled periodic build in an executor
* @async  _stopPeriodic
* @param  {Object}  config        Configuration
* @param  {Integer} config.jobId  ID of the job with periodic builds
* @return {Promise}
*/
async function stopPeriodic(executor, config) {
    await executor.connect();

    await executor.queueBreaker.runCommand('delDelayed', executor.periodicBuildQueue,
        'startDelayed',
        [{
            jobId: config.jobId
        }]);

    return executor.redisBreaker.runCommand('hdel', executor.periodicBuildTable, config.jobId);
}

/**
 * Starts a new periodic build in an executor
 * @method startPeriodic
 * @param {Object}   config              Configuration
 * @param {Object}   config.pipeline     Pipeline of the job
 * @param {Object}   config.job          Job object to create periodic builds for
 * @param {String}   config.apiUri       Base URL of the Screwdriver API
 * @param {Function} config.tokenGen     Function to generate JWT from username, scope and scmContext
 * @param {Boolean}  config.isUpdate     Boolean to determine if updating existing periodic build
 * @param {Boolean}  config.triggerBuild Flag to post new build event
 * @return {Promise}
 */
async function startPeriodic(executor, config) {
    const { pipeline, job, tokenGen, isUpdate, triggerBuild } = config;
    // eslint-disable-next-line max-len
    const buildCron = reach(job, 'permutations>0>annotations>screwdriver.cd/buildPeriodically',
        { separator: '>' });

    // Save tokenGen to current executor object so we can access it in postBuildEvent
    if (!executor.userTokenGen) {
        executor.userTokenGen = tokenGen;
    }

    if (isUpdate) {
        // TODO: move this
        await stopPeriodic(executor, { jobId: job.id });
    }

    if (triggerBuild) {
        config.causeMessage = 'Started by periodic build scheduler';

        // Even if post event failed for this event after retry, we should still enqueue the next event
        try {
            await postBuildEvent(config);
        } catch (err) {
            logger.error('periodic builds: failed to post build event for job'
                + `${job.id} in pipeline ${pipeline.id}: ${err}`);
        }
    }

    if (buildCron && job.state === 'ENABLED' && !job.archived) {
        await executor.connect();

        const next = cron.next(cron.transform(buildCron, job.id));

        // Store the config in redis
        await executor.redisBreaker.runCommand('hset', executor.periodicBuildTable,
            job.id, JSON.stringify(Object.assign(config, {
                isUpdate: false,
                triggerBuild: false
            })));

        // Note: arguments to enqueueAt are [timestamp, queue name, job name, array of args]
        let shouldRetry = false;

        try {
            await executor.queue.enqueueAt(next, executor.periodicBuildQueue,
                'startDelayed', [{ jobId: job.id }]);
        } catch (err) {
            // Error thrown by node-resque if there is duplicate: https://github.com/taskrabbit/node-resque/blob/master/lib/queue.js#L65
            // eslint-disable-next-line max-len
            if (err && err.message !== 'Job already enqueued at this time with same arguments') {
                shouldRetry = true;
            }
        }
        if (!shouldRetry) {
            return Promise.resolve();
        }
        try {
            await executor.queueBreaker.runCommand('enqueueAt', next,
                executor.periodicBuildQueue, 'startDelayed', [{ jobId: job.id }]);
        } catch (err) {
            logger.error(`failed to add to delayed queue for job ${job.id}: ${err}`);
        }
    }

    return Promise.resolve();
}

/**
 * Starts a new build in an executor
 * @async  start
 * @param  {Object} config               Configuration
 * @param  {Object} [config.annotations] Optional key/value object
 * @param  {Number} [config.eventId]     Optional eventID that this build belongs to
 * @param  {String} config.build         Build object
 * @param  {Array}  config.blockedBy     Array of job IDs that this job is blocked by. Always blockedby itself
 * @param  {String} config.causeMessage  Reason the event is run
 * @param  {Array}  config.freezeWindows Array of cron expressions that this job cannot run during
 * @param  {String} config.apiUri        Screwdriver's API
 * @param  {String} config.jobId         JobID that this build belongs to
 * @param  {String} config.jobName       Name of job that this build belongs to
 * @param  {String} config.jobState      ENABLED/DISABLED
 * @param  {String} config.jobArchived   Boolean value of whether job is archived
 * @param  {String} config.buildId       Unique ID for a build
 * @param  {Object} config.pipeline      Pipeline of the job
 * @param  {Fn}     config.tokenGen      Function to generate JWT from username, scope and scmContext
 * @param  {String} config.container     Container for the build to run in
 * @param  {String} config.token         JWT to act on behalf of the build
 * @return {Promise}
 */
async function start(executor, config) {
    await executor.connect();
    const {
        build,
        buildId,
        causeMessage,
        jobId,
        jobState,
        jobArchived,
        blockedBy,
        freezeWindows,
        token,
        apiUri
    } = config;
    const forceStart = /\[(force start)\]/.test(causeMessage);

    if (!executor.tokenGen) {
        executor.tokenGen = config.tokenGen;
    }

    delete config.build;
    delete config.causeMessage;

    // TODO: move this
    await stopFrozen(executor, {
        jobId
    });

    // Skip if job is disabled or archived
    if (jobState === 'DISABLED' || jobArchived === true) {
        return Promise.resolve();
    }

    const currentTime = new Date();
    const origTime = new Date(currentTime.getTime());

    timeOutOfWindows(freezeWindows, currentTime);

    let enq;

    // Check freeze window
    if (currentTime.getTime() > origTime.getTime() && !forceStart) {
        await helper.updateBuildStatusWithRetry({
            buildId,
            token,
            apiUri,
            status: 'FROZEN',
            statusMessage: `Blocked by freeze window, re-enqueued to ${currentTime}`
        }, executor.requestRetryStrategy).catch((err) => {
            logger.error(`failed to update build status for build ${buildId}: ${err}`);

            return Promise.resolve();
        });

        // Remove old job from queue to collapse builds
        await executor.queueBreaker.runCommand('delDelayed', executor.frozenBuildQueue,
            'startFrozen', [{
                jobId
            }]);

        await executor.redisBreaker.runCommand('hset', executor.frozenBuildTable,
            jobId, JSON.stringify(config));

        // Add new job back to queue
        enq = await executor.queueBreaker.runCommand('enqueueAt', currentTime.getTime(),
            executor.frozenBuildQueue, 'startFrozen', [{
                jobId
            }]
        );
    } else {
        // set the start time in the queue
        Object.assign(config, { token });
        // Store the config in redis
        await executor.redisBreaker.runCommand('hset', executor.buildConfigTable,
            buildId, JSON.stringify(config));

        // Note: arguments to enqueue are [queue name, job name, array of args]
        enq = await executor.queueBreaker.runCommand('enqueue', executor.buildQueue, 'start', [{
            buildId,
            jobId,
            blockedBy: blockedBy.toString()
        }]);
    }

    // for backward compatibility
    if (build && build.stats) {
        // need to reassign so the field can be dirty
        build.stats = merge(build.stats, { queueEnterTime: (new Date()).toISOString() });
        await build.update();
    }

    return enq;
}

/**
 * Intializes the scheduler and multiworker
 * @async  init
 * @param {Object} executor
 * @return {Promise}
 */
async function init(executor) {
    if (executor.multiWorker) return;

    const redisConnection = executor.redisConnection;
    const retryOptions = {
        plugins: ['Retry'],
        pluginOptions: {
            Retry: {
                retryLimit: RETRY_LIMIT,
                retryDelay: RETRY_DELAY
            }
        }
    };
    // Jobs object to register the worker with
    const jobs = {
        startDelayed: Object.assign({
            perform: async (jobConfig) => {
                try {
                    const fullConfig = await executor.redisBreaker
                        .runCommand('hget', executor.periodicBuildTable, jobConfig.jobId);

                    return await startPeriodic(
                        Object.assign(JSON.parse(fullConfig), { triggerBuild: true }));
                } catch (err) {
                    logger.error(`err in startDelayed job: ${err}`);
                    throw err;
                }
            }
        }, retryOptions),
        startFrozen: Object.assign({
            perform: async (jobConfig) => {
                try {
                    const fullConfig = await executor.redisBreaker
                        .runCommand('hget', executor.frozenBuildTable, jobConfig.jobId);

                    return await startFrozen(JSON.parse(fullConfig));
                } catch (err) {
                    logger.error(`err in startFrozen job: ${err}`);
                    throw err;
                }
            }
        }, retryOptions)
    };

    executor.multiWorker = new Resque.MultiWorker({
        connection: redisConnection,
        queues: [executor.periodicBuildQueue, executor.frozenBuildQueue],
        minTaskProcessors: 1,
        maxTaskProcessors: 10,
        checkTimeout: 1000,
        maxEventLoopDelay: 10,
        toDisconnectProcessors: true
    }, jobs);

    executor.scheduler = new Resque.Scheduler({ connection: redisConnection });

    executor.multiWorker.on('start', workerId =>
        logger.info(`worker[${workerId}] started`));
    executor.multiWorker.on('end', workerId =>
        logger.info(`worker[${workerId}] ended`));
    executor.multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
        logger.info(`cleaning old worker ${worker} pid ${pid}`));
    executor.multiWorker.on('job', (workerId, queue, job) =>
        logger.info(`worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`));
    executor.multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
        logger.info(`worker[${workerId}] reEnqueue job (${plugin})`
            + `${queue} ${JSON.stringify(job)}`));
    executor.multiWorker.on('success', (workerId, queue, job, result) =>
        logger.info(`worker[${workerId}] job success ${queue}` +
            `${JSON.stringify(job)} >> ${result}`));
    executor.multiWorker.on('failure', (workerId, queue, job, failure) =>
        logger.info(`worker[${workerId}] job failure ${queue}` +
            `${JSON.stringify(job)} >> ${failure}`));
    executor.multiWorker.on('error', (workerId, queue, job, error) =>
        logger.error(`worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`));

    // multiWorker emitters
    executor.multiWorker.on('internalError', error =>
        logger.error(error));

    executor.scheduler.on('start', () =>
        logger.info('scheduler started'));
    executor.scheduler.on('end', () =>
        logger.info('scheduler ended'));
    executor.scheduler.on('master', state =>
        logger.info(`scheduler became master ${state}`));
    executor.scheduler.on('error', error =>
        logger.info(`scheduler error >> ${error}`));
    executor.scheduler.on('workingTimestamp', timestamp =>
        logger.info(`scheduler working timestamp ${timestamp}`));
    executor.scheduler.on('transferredJob', (timestamp, job) =>
        logger.info(`scheduler enqueuing job timestamp  >>  ${JSON.stringify(job)}`));

    await executor.multiWorker.start();
    await executor.scheduler.connect();
    await executor.scheduler.start();
}

/**
 * Adds start time of a build to timeout queue
 * @method startTimer
 * @param  {Object} config               Configuration
 * @param  {String} config.buildId       Unique ID for a build
 * @param  {String} config.startTime     Start time fo build
 * @param  {String} config.buildStatus     Status of build
 * @return {Promise}
 */
async function startTimer(executor, config) {
    try {
        await executor.connect();
        const {
            buildId,
            jobId,
            buildStatus,
            startTime
        } = config;

        if (buildStatus === 'RUNNING') {
            const buildTimeout = reach(config, 'annotations>screwdriver.cd/timeout',
                { separator: '>' });
            const timeout = parseInt(buildTimeout || DEFAULT_BUILD_TIMEOUT, 10);

            const data = await executor.redisBreaker.runCommand('hget',
                executor.timeoutQueue, buildId);

            if (data) {
                return Promise.resolve();
            }

            return await executor.redisBreaker.runCommand('hset', executor.timeoutQueue, buildId,
                JSON.stringify({
                    jobId,
                    startTime,
                    timeout
                }));
        }

        return Promise.resolve();
    } catch (err) {
        logger.error(`Error occurred while saving to timeout queue ${err}`);

        return Promise.resolve();
    }
}

module.exports = () => ({
    method: 'POST',
    path: '/queue/message',
    config: {
        description: 'Puts a message to the queue',
        notes: 'Should add a message to the queue',
        tags: ['api', 'queue'],
        handler: async (request, h) => {
            const executor = request.server.app.executorQueue;

            if (!executor.multiWorker) {
                await init(executor);

                return h.response({}).code(200);
            }

            const type = request.query.type;

            switch (type) {
            case 'periodic':
                await startPeriodic(executor, request.payload);
                break;
            case 'frozen':
                await startFrozen(executor, request.payload);
                break;
            case 'timer':
                await startTimer(executor, request.payload);
                break;
            default:
                await start(executor, request.payload);
                break;
            }

            return h.response({}).code(200);
        }
    }
});
