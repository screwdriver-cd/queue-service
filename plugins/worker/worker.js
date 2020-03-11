'use strict';

const NodeResque = require('node-resque');
const config = require('config');
const Redis = require('ioredis');
const logger = require('screwdriver-logger');
const jobs = require('./lib/jobs');
const timeout = require('./lib/timeout');
const helper = require('../helper');
const workerConfig = config.get('worker');
const { connectionDetails, queuePrefix } = require('../../config/redis');
const redis = new Redis(
    connectionDetails.port,
    connectionDetails.host,
    connectionDetails.options
);

/**
 * Shutdown both worker and scheduler and then exit the process
 * @method shutDownAll
 * @param  {Object}       worker        worker to be ended
 * @param  {Object}       scheduler     scheduler to be ended
 */
async function shutDownAll(worker, scheduler) {
    try {
        await worker.end();
    } catch (error) {
        logger.error(`failed to end the worker: ${error}`);
    }

    try {
        await scheduler.end();
        process.exit(0);
    } catch (err) {
        logger.error(`failed to end the scheduler: ${err}`);
        process.exit(128);
    }
}

const multiWorker = new NodeResque.MultiWorker(
    {
        connection: connectionDetails,
        queues: [`${queuePrefix}builds`],
        minTaskProcessors: workerConfig.minTaskProcessors,
        maxTaskProcessors: workerConfig.maxTaskProcessors,
        checkTimeout: workerConfig.checkTimeout,
        maxEventLoopDelay: workerConfig.maxEventLoopDelay
    },
    jobs
);

const scheduler = new NodeResque.Scheduler({ connection: connectionDetails });

/**
 * Start worker & scheduler
 * @method invoke
 * @return {Promise}
 */
async function invoke() {
    try {
        /* eslint-disable max-len */
        multiWorker.on('start', workerId =>
            logger.info(`queueWorker->worker[${workerId}] started`)
        );
        multiWorker.on('end', workerId =>
            logger.info(`queueWorker->worker[${workerId}] ended`)
        );
        multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
            logger.info(`queueWorker->cleaning old worker ${worker} pid ${pid}`)
        );
        multiWorker.on('poll', async (workerId, queue) => {
            logger.info(`queueWorker->worker[${workerId}] polling ${queue}`);
            await timeout.check(redis, queue);
        });
        multiWorker.on('job', (workerId, queue, job) =>
            logger.info(
                `queueWorker->worker[${workerId}] working job ${queue} ${JSON.stringify(
                    job
                )}`
            )
        );
        multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
            logger.info(
                `queueWorker->worker[${workerId}] reEnqueue job (${JSON.stringify(
                    plugin
                )}) ${queue} ${JSON.stringify(job)}`
            )
        );
        multiWorker.on('success', (workerId, queue, job, result) =>
            logger.info(
                `queueWorker->worker[${workerId}] ${job} success ${queue} ` +
                    `${JSON.stringify(job)} >> ${result}`
            )
        );
        multiWorker.on('failure', (workerId, queue, job, failure) =>
            helper.updateBuildStatus(
                {
                    redisInstance: redis,
                    buildId: job.args[0].buildId,
                    status: 'FAILURE',
                    statusMessage: `${failure}`
                },
                (err, response) => {
                    if (!err) {
                        logger.error(
                            `queueWorker->worker[${workerId}] ${JSON.stringify(
                                job
                            )} ` +
                                `failure ${queue} ` +
                                `${JSON.stringify(
                                    job
                                )} >> successfully update build status: ${failure}`
                        );
                    } else {
                        logger.error(
                            `queueWorker->worker[${workerId}] ${job} failure ` +
                                `${queue} ${JSON.stringify(job)} ` +
                                `>> ${failure} ${err} ${JSON.stringify(
                                    response
                                )}`
                        );
                    }
                }
            )
        );
        multiWorker.on('error', (workerId, queue, job, error) =>
            logger.error(
                `queueWorker->worker[${workerId}] error ${queue} ${JSON.stringify(
                    job
                )} >> ${error}`
            )
        );
        multiWorker.on('pause', workerId =>
            logger.info(`queueWorker->worker[${workerId}] paused`)
        );

        // multiWorker emitters
        multiWorker.on('internalError', error => logger.error(error));
        multiWorker.on('multiWorkerAction', (verb, delay) =>
            logger.info(
                `queueWorker->*** checked for worker status: ${verb} ` +
                    `(event loop delay: ${delay}ms)`
            )
        );

        scheduler.on('start', () =>
            logger.info('queueWorker->scheduler started')
        );
        scheduler.on('end', () => logger.info('queueWorker->scheduler ended'));
        scheduler.on('poll', () =>
            logger.info('queueWorker->scheduler polling')
        );
        scheduler.on('master', state =>
            logger.info(`queueWorker->scheduler became master ${state}`)
        );
        scheduler.on('error', error =>
            logger.info(`queueWorker->scheduler error >> ${error}`)
        );
        scheduler.on('working_timestamp', timestamp =>
            logger.info(`queueWorker->scheduler working timestamp ${timestamp}`)
        );
        scheduler.on('transferred_job', (timestamp, job) =>
            logger.info(
                `queueWorker->scheduler enqueuing job timestamp  >>  ${JSON.stringify(
                    job
                )}`
            )
        );

        multiWorker.start();

        await scheduler.connect();
        scheduler.start();

        // Shut down workers before exit the process
        process.on('SIGTERM', async () => shutDownAll(multiWorker, scheduler));

        return 'Worker Started';
    } catch (err) {
        logger.error(`failed to start the worker: ${err}`);
        throw err;
    }
}

module.exports = {
    invoke,
    multiWorker,
    scheduler,
    shutDownAll
};
