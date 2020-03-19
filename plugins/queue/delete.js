'use strict';

const logger = require('screwdriver-logger');
const EXPIRE_TIME = 1800; // 30 mins

/**
 * Stops a previously scheduled periodic build in an executor
 * @async  _stopPeriodic
 * @param  {Object}  config        Configuration
 * @param  {Integer} config.jobId  ID of the job with periodic builds
 * @return {Promise}
 */
async function stopPeriodic(executor, config) {
    await executor.connect();

    await executor.queueBreaker.runCommand('delDelayed', executor.periodicBuildQueue, 'startDelayed', [
        { jobId: config.jobId }
    ]);

    return executor.redisBreaker.runCommand('hdel', executor.periodicBuildTable, config.jobId);
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

    await executor.queueBreaker.runCommand('delDelayed', executor.frozenBuildQueue, 'startFrozen', [
        { jobId: config.jobId }
    ]);

    return executor.redisBreaker.runCommand('hdel', executor.frozenBuildTable, config.jobId);
}

/**
 * Removes start time info key from timeout queue
 * @method status
 * @param  {Object} config               Configuration
 * @param  {String} config.buildId       Unique ID for a build
 * @return {Promise}
 */
async function stopTimer(executor, config) {
    try {
        await executor.connect();

        const data = await executor.redisBreaker.runCommand('hget', executor.timeoutQueue, config.buildId);

        if (!data) {
            return Promise.resolve();
        }

        return await executor.redisBreaker.runCommand('hdel', executor.timeoutQueue, config.buildId);
    } catch (err) {
        logger.error(`Error occurred while removing from timeout queue ${err}`);

        return Promise.resolve();
    }
}

/**
 * Stop a running or finished build
 * @async  _stop
 * @param  {Object} config               Configuration
 * @param  {Array}  config.blockedBy     Array of job IDs that this job is blocked by. Always blockedby itself
 * @param  {String} config.buildId       Unique ID for a build
 * @param  {String} config.jobId         JobID that this build belongs to
 * @return {Promise}
 */
async function stop(executor, config) {
    await executor.connect();

    const { buildId, jobId } = config; // in case config contains something else

    let blockedBy;

    if (config.blockedBy !== undefined) {
        blockedBy = config.blockedBy.toString();
    }

    const numDeleted = await executor.queueBreaker.runCommand('del', executor.buildQueue, 'start', [
        {
            buildId,
            jobId,
            blockedBy
        }
    ]);
    const deleteKey = `deleted_${jobId}_${buildId}`;
    let started = true;

    // This is to prevent the case where a build is aborted while still in buildQueue
    // The job might be picked up by the worker, so it's not deleted from buildQueue here
    // Immediately after, the job gets put back to the queue, so it's always inside buildQueue
    // This key will be cleaned up automatically or when it's picked up by the worker
    await executor.redisBreaker.runCommand('set', deleteKey, '');
    await executor.redisBreaker.runCommand('expire', deleteKey, EXPIRE_TIME);

    if (numDeleted !== 0) {
        // build hasn't started
        started = false;
    }

    return executor.queueBreaker.runCommand('enqueue', executor.buildQueue, 'stop', [
        {
            buildId,
            jobId,
            blockedBy,
            started // call executor.stop if the job already started
        }
    ]);
}

module.exports = () => ({
    method: 'DELETE',
    path: '/queue/message',
    config: {
        description: 'Deletes a message to the queue',
        notes: 'Should delete a message from the queue',
        tags: ['api', 'queue'],
        handler: async (request, h) => {
            try {
                const executor = request.server.app.executorQueue;
                const { type } = request.query;

                switch (type) {
                    case 'periodic':
                        await stopPeriodic(executor, request.payload);
                        break;
                    case 'frozen':
                        await stopFrozen(executor, request.payload);
                        break;
                    case 'timer':
                        await stopTimer(executor, request.payload);
                        break;
                    default:
                        await stop(executor, request.payload);
                        break;
                }

                return h.response({}).code(200);
            } catch (err) {
                logger.error('Error in adding message from queue', err);

                throw err;
            }
        }
    }
});
