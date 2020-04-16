'use strict';

const logger = require('screwdriver-logger');
const helper = require('../../helper.js');
const { waitingJobsPrefix, runningJobsPrefix, queuePrefix } = require('../../../config/redis');
const TIMEOUT_CODE = 3;
const TIMEOUT_BUFFER = 1;
const DEFAULT_TIMEOUT = 90;
const hash = `${queuePrefix}timeoutConfigs`;
const REDIS_LOCK_TTL = 1000; // in ms

/**
 * Wrapper function to process timeout logic
 * @method process
 * @param {Object} timeoutConfig
 * @param {String} buildId
 * @param {Object} redis
 * @param {String} workerId
 * @return {Promise}
 */
async function process(timeoutConfig, buildId, redis, workerId) {
    try {
        const { jobId } = timeoutConfig;
        const runningKey = `${runningJobsPrefix}${jobId}`;
        const lastRunningKey = `last_${runningJobsPrefix}${jobId}`;
        const waitingKey = `${waitingJobsPrefix}${jobId}`;
        const deleteKey = `deleted_${jobId}_${buildId}`;
        const timeoutValue = parseInt(timeoutConfig.timeout, 10);
        const timeout = (Number.isNaN(timeoutValue) ? DEFAULT_TIMEOUT : timeoutValue) + TIMEOUT_BUFFER; // set timeout 1 min more than the launcher
        const { startTime } = timeoutConfig;

        if (!startTime) {
            // there is no startTime set for the build
            logger.warn(`worker[${workerId}] -> startTime not set for buildId: ${buildId}`);

            return;
        }

        const diffMs = new Date().getTime() - new Date(startTime).getTime();
        const diffMins = Math.round(diffMs / 60000);

        // check if build has timed out, if yes abort build
        if (diffMins > timeout) {
            let step;

            try {
                step = await helper.getCurrentStep({
                    redisInstance: redis,
                    buildId
                });
            } catch (err) {
                logger.error(`worker[${workerId}] -> No active step found for ${buildId}`);
            }

            if (step) {
                await helper.updateStepStop({
                    redisInstance: redis,
                    buildId,
                    stepName: step.name,
                    code: TIMEOUT_CODE
                });
            }

            await helper.updateBuildStatus({
                redisInstance: redis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout'
            });

            logger.info(`worker[${workerId}] -> Build has timed out ${buildId}`);

            await redis.hdel(`${queuePrefix}buildConfigs`, buildId);

            // expire now as build failed
            await redis.expire(runningKey, 0);
            await redis.expire(lastRunningKey, 0);

            await redis.del(deleteKey);
            await redis.lrem(waitingKey, 0, buildId);

            // remove from timeout configs after build is timed out
            await redis.hdel(hash, buildId);
        }
    } catch (err) {
        // delete key from redis in case of error to prevent reprocessing
        await redis.hdel(hash, buildId);

        logger.error(`worker[${workerId}] -> Error occurred while checking timeout for buildId : ${buildId} : ${err}`);
    }
}

/**
 * Check if the build has timed out
 * If yes, abort build.
 * @method check
 * @param {Object} redis
 * @param {Object} redlock
 * @return {Promise}
 */
async function check(redis, redlock, workerId) {
    const keys = await redis.hkeys(hash);

    if (!keys || keys.length === 0) return;

    await Promise.all(
        keys.map(async buildId => {
            try {
                const lock = await redlock.lock(buildId, REDIS_LOCK_TTL);
                const json = await redis.hget(hash, buildId);

                if (!json) return;
                const timeoutConfig = JSON.parse(json);

                if (!timeoutConfig) {
                    // this build or pipeline has already been deleted
                    return;
                }

                await process(timeoutConfig, buildId, redis, workerId);

                await lock.unlock();
            } catch (err) {
                logger.error(`worker[${workerId}] -> Redis locking error ${buildId}`, err.message);
            }
        })
    );
}

/**
 * Worker Map object storing
 * last checked time for each worker
 */
const workerAccessMap = {};

/**
 *
 * @param {Object} redis
 * @param {Object} redlock
 * @param {Number} workerId
 * @param {Number} pollInterval
 */
async function checkWithBackOff(redis, redlock, workerId, pollInterval = 60) {
    workerAccessMap[workerId] = workerAccessMap[workerId] || new Date();
    const diffMs = new Date().getTime() - new Date(workerAccessMap[workerId]).getTime();
    const diffSeconds = Math.round(diffMs / 1000);

    // poll every 60 seconds
    if (diffSeconds >= pollInterval) {
        logger.info('worker[%s] -> Processing timeout checks', workerId);
        await check(redis, redlock, workerId);
        workerAccessMap[workerId] = new Date();
    }
}

module.exports.checkWithBackOff = checkWithBackOff;
