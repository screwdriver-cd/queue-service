
const NodeResque = require('node-resque');
const config = require('config');
const jobs = require('./lib/jobs');
const timeout = require('./lib/timeout');
const helper = require('../helper');
const Redis = require('ioredis');
const logger = require('screwdriver-logger');
const workerConfig = config.get('worker');
const { connectionDetails, queuePrefix } = require('../../config/redis');
const redis = new Redis(
    connectionDetails.port, connectionDetails.host, connectionDetails.options);

module.exports = () => ({
    method: 'POST',
    path: '/queue/scheduler',
    config: {
        description: 'Reads and process a message from the queue',
        notes: 'Should process a message from the queue',
        tags: ['api', 'queue'],
        handler: async (request, reply) => {
            await schedule(request);
            reply({})
        }
    }
});

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

const multiWorker = new NodeResque.MultiWorker({
    connection: connectionDetails,
    queues: [`${queuePrefix}builds`],
    minTaskProcessors: workerConfig.minTaskProcessors,
    maxTaskProcessors: workerConfig.maxTaskProcessors,
    checkTimeout: workerConfig.checkTimeout,
    maxEventLoopDelay: workerConfig.maxEventLoopDelay
}, jobs);

const scheduler = new NodeResque.Scheduler({ connection: connectionDetails });

/**
 * Start worker & scheduler
 * @method boot
 * @return {Promise}
 */
async function schedule() {
    /* eslint-disable max-len */
    multiWorker.on('start', workerId =>
        logger.info(`worker[${workerId}] started`));
    multiWorker.on('end', workerId =>
        logger.info(`worker[${workerId}] ended`));
    multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
        logger.info(`cleaning old worker ${worker} pid ${pid}`));
    multiWorker.on('poll', async (workerId, queue) => {
        logger.info(`worker[${workerId}] polling ${queue}`);
        await timeout.check(redis, queue);
    });
    multiWorker.on('job', (workerId, queue, job) =>
        logger.info(`worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`));
    multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
        logger.info(`worker[${workerId}] reEnqueue job (${JSON.stringify(plugin)}) ${queue} ${JSON.stringify(job)}`));
    multiWorker.on('success', (workerId, queue, job, result) =>
        logger.info(`worker[${workerId}] ${job} success ${queue} ${JSON.stringify(job)} >> ${result}`));
    multiWorker.on('failure', (workerId, queue, job, failure) =>
        helper.updateBuildStatus({
            redisInstance: redis,
            buildId: job.args[0].buildId,
            status: 'FAILURE',
            statusMessage: `${failure}`
        }, (err, response) => {
            if (!err) {
                logger.error(`worker[${workerId}] ${JSON.stringify(job)} failure ${queue} ${JSON.stringify(job)} >> successfully update build status: ${failure}`);
            } else {
                logger.error(`worker[${workerId}] ${job} failure ${queue} ${JSON.stringify(job)} >> ${failure} ${err} ${JSON.stringify(response)}`);
            }
        }));
    multiWorker.on('error', (workerId, queue, job, error) =>
        logger.error(`worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`));
    multiWorker.on('pause', workerId =>
        logger.info(`worker[${workerId}] paused`));
    /* eslint-enable max-len */

    // multiWorker emitters
    multiWorker.on('internalError', error =>
        logger.error(error));
    multiWorker.on('multiWorkerAction', (verb, delay) =>
        logger.info(`*** checked for worker status: ${verb} (event loop delay: ${delay}ms)`));

    scheduler.on('start', () =>
        logger.info('scheduler started'));
    scheduler.on('end', () =>
        logger.info('scheduler ended'));
    scheduler.on('poll', () =>
        logger.info('scheduler polling'));
    scheduler.on('master', state =>
        logger.info(`scheduler became master ${state}`));
    scheduler.on('error', error =>
        logger.info(`scheduler error >> ${error}`));
    scheduler.on('working_timestamp', timestamp =>
        logger.info(`scheduler working timestamp ${timestamp}`));
    scheduler.on('transferred_job', (timestamp, job) =>
        logger.info(`scheduler enqueuing job timestamp  >>  ${JSON.stringify(job)}`));

    multiWorker.start();

    await scheduler.connect();
    scheduler.start();

    // Shut down workers before exit the process
    process.on('SIGTERM', async () => shutDownAll(multiWorker, scheduler));
}