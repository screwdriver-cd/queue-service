'use strict';

const { MultiWorker, Scheduler } = require('node-resque');
const config = require('config');
const logger = require('screwdriver-logger');
const Redlock = require('redlock');
const jobs = require('./lib/jobs');
const timeout = require('./lib/timeout');
const helper = require('../helper');
const workerConfig = config.get('worker');
const { queueNamespace, queuePrefix } = require('../../config/redis');
const redis = require('../redis');
// https://github.com/mike-marcacci/node-redlock
const redlock = new Redlock([redis], {
    driftFactor: 0.01, // time in ms
    retryCount: 5,
    retryDelay: 200, // time in ms
    retryJitter: 200 // time in ms
});
const resqueConnection = { redis, namespace: queueNamespace };

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
    } catch (err) {
        logger.error(`failed to end the scheduler: ${err}`);
    }
}

const multiWorker = new MultiWorker(
    {
        connection: resqueConnection,
        queues: [`${queuePrefix}builds`, `${queuePrefix}cache`, `${queuePrefix}webhooks`],
        minTaskProcessors: parseInt(workerConfig.minTaskProcessors, 10),
        maxTaskProcessors: parseInt(workerConfig.maxTaskProcessors, 10),
        checkTimeout: parseInt(workerConfig.checkTimeout, 10),
        maxEventLoopDelay: parseInt(workerConfig.maxEventLoopDelay, 10)
    },
    jobs
);

const scheduler = new Scheduler({ connection: resqueConnection });

/**
 * Start worker & scheduler
 * @method invoke
 * @return {Promise}
 */
async function invoke() {
    try {
        /* eslint-disable max-len */
        multiWorker.on('start', workerId => logger.info(`queueWorker->worker[${workerId}] started`));
        multiWorker.on('end', workerId => logger.info(`queueWorker->worker[${workerId}] ended`));
        multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
            logger.info(`queueWorker->cleaning old worker ${worker}${workerId} pid ${pid}`)
        );
        multiWorker.on('poll', async (workerId, queue) => {
            if (queue === 'builds') {
                logger.info(`queueWorker->worker[${workerId}] polling ${queue}`);
                await timeout.checkWithBackOff(redis, redlock, workerId);
            }
        });
        multiWorker.on('job', (workerId, queue, job) =>
            logger.info(`queueWorker->worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`)
        );
        multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
            logger.info(
                `queueWorker->worker[${workerId}] reEnqueue job (${JSON.stringify(plugin)}) ${queue} ${JSON.stringify(
                    job
                )}`
            )
        );
        multiWorker.on('success', (workerId, queue, job, result, duration) =>
            logger.info(
                `queueWorker->worker[${workerId}] ${job} success ${queue} ${JSON.stringify(
                    job
                )} >> ${result} (${duration}ms)`
            )
        );
        multiWorker.on('failure', (workerId, queue, job, failure, duration) =>
            helper
                .updateBuildStatus({
                    redisInstance: redis,
                    buildId: job.args[0].buildId,
                    status: 'FAILURE',
                    statusMessage: `${failure}`
                })
                .then(() => {
                    logger.info(
                        `queueWorker->worker[${workerId}] ${JSON.stringify(job)} ` +
                            `failure ${queue} ` +
                            `${JSON.stringify(job)} >> successfully update build status: ${failure} (${duration}ms)`
                    );
                })
                .catch(err => {
                    logger.error(
                        `queueWorker->worker[${workerId}] ${job} failure ` +
                            `${queue} ${JSON.stringify(job)} ` +
                            `>> ${failure} (${duration}ms) ${err}`
                    );
                })
        );
        multiWorker.on('error', (workerId, queue, job, error) =>
            logger.error(`queueWorker->worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`)
        );
        multiWorker.on('pause', workerId => logger.info(`queueWorker->worker[${workerId}] paused`));

        // multiWorker emitters
        multiWorker.on('multiWorkerAction', (verb, delay) =>
            logger.info(`queueWorker->*** checked for worker status: ${verb} (event loop delay: ${delay}ms)`)
        );

        scheduler.on('start', () => logger.info('queueWorker->scheduler started'));
        scheduler.on('end', () => logger.info('queueWorker->scheduler ended'));
        scheduler.on('poll', () => logger.info('queueWorker->scheduler polling'));
        scheduler.on('leader', () => logger.info(`queueWorker->scheduler became leader`));
        scheduler.on('error', error => logger.info(`queueWorker->scheduler error >> ${error}`));
        scheduler.on('workingTimestamp', timestamp =>
            logger.info(`queueWorker->scheduler working timestamp ${timestamp}`)
        );
        scheduler.on('transferredJob', (timestamp, job) =>
            logger.info(`queueWorker->scheduler enqueuing job timestamp  >> ${timestamp} ${JSON.stringify(job)}`)
        );
        scheduler.on('cleanStuckWorker', (workerName, errorPayload, delta) =>
            logger.info(
                `queueWorker->scheduler failing ${workerName} (stuck for ${delta}s) and failing job ${errorPayload}`
            )
        );
        multiWorker.start();

        await scheduler.connect();
        scheduler.start();

        return 'Worker Started';
    } catch (err) {
        logger.error(`failed to start the worker: ${err}`);
        throw err;
    }
}

/**
 * Cleanup worker and scheduler
 * @method invoke
 * @return {Promise}
 */
async function cleanUp() {
    // Shut down workers before exit the process
    await shutDownAll(multiWorker, scheduler);
}

module.exports = {
    invoke,
    multiWorker,
    scheduler,
    shutDownAll,
    cleanUp
};
