'use strict';

const logger = require('screwdriver-logger');
const helper = require('../../helper');
const { waitingJobsPrefix, runningJobsPrefix, queuePrefix } = require('../../../config/redis');

let luaScriptLoader;

/**
 * Get LuaScriptLoader instance
 * @return {LuaScriptLoader} Lua script loader instance
 */
function getLuaScriptLoader() {
    if (!luaScriptLoader) {
        // eslint-disable-next-line global-require
        const worker = require('../worker');

        luaScriptLoader = worker.luaScriptLoader;
    }

    return luaScriptLoader;
}

const TIMEOUT_CODE = 3;
const DEFAULT_TIMEOUT = 90;
const hash = `${queuePrefix}timeoutConfigs`;

/**
 * Execute timeout cleanup
 * @param {Object} decision
 * @param {String} buildId
 * @param {Object} redis
 * @param {String} workerId
 * @param {Object} buildConfig - Build config fetched before Lua execution
 * @return {Promise}
 */
async function executeTimeout(decision, buildId, redis, workerId, buildConfig) {
    const { timeoutMinutes } = decision;

    // Get and update current step
    let step;

    try {
        step = await helper.getCurrentStep({
            redisInstance: redis,
            buildId,
            buildConfig
        });
    } catch (err) {
        logger.error(`worker[${workerId}] -> No active step found for ${buildId}`);
    }

    if (step) {
        await helper.updateStepStop({
            redisInstance: redis,
            buildId,
            stepName: step.name,
            code: TIMEOUT_CODE,
            buildConfig
        });
    }

    await helper.updateBuildStatus({
        redisInstance: redis,
        buildId,
        status: 'FAILURE',
        statusMessage: `Build failed due to timeout (${timeoutMinutes} minutes)`,
        buildConfig
    });

    logger.info(`worker[${workerId}] -> Timeout cleanup completed for build ${buildId}`);
}

/**
 * Handle the decision from Lua script
 * @param {Object} decision - {action, reason, buildId, ...}
 * @param {String} buildId - Build ID
 * @param {Object} redis - Redis instance
 * @param {String} workerId - Worker ID
 * @param {Object} buildConfig - Build config fetched before Lua execution
 * @return {Promise}
 */
async function handleDecision(decision, buildId, redis, workerId, buildConfig) {
    switch (decision.action) {
        case 'TIMEOUT':
            // Build has timed out - execute cleanup
            logger.info(`worker[${workerId}] -> Build has timed out ${buildId}`);
            await executeTimeout(decision, buildId, redis, workerId, buildConfig);
            break;

        case 'CLEANUP':
            // Build already completed/cleaned up - just remove from timeout configs
            logger.info(`worker[${workerId}] -> Build ${buildId} ${decision.reason}, cleaning up`);
            await redis.hdel(hash, buildId);
            break;

        case 'SKIP':
            // Build still within timeout - do nothing
            break;

        default:
            logger.error(`worker[${workerId}] -> Unknown timeout action: ${decision.action}`);
    }
}

/**
 * @method process
 * @param {Object} timeoutConfig
 * @param {String} buildId
 * @param {Object} redis
 * @param {String} workerId
 * @return {Promise}
 */
async function process(timeoutConfig, buildId, redis, workerId) {
    const { jobId, startTime, timeout } = timeoutConfig;

    logger.info(`worker[${workerId}] -> Checking timeout for build ${buildId} (job ${jobId})`);

    if (!startTime) {
        logger.warn(`worker[${workerId}] -> startTime not set for buildId: ${buildId}`);
        await redis.hdel(hash, buildId);

        return;
    }

    try {
        // Fetch buildConfig BEFORE Lua execution (Lua script will delete it if timeout)
        const buildConfigJson = await redis.hget(`${queuePrefix}buildConfigs`, buildId);
        const buildConfig = buildConfigJson ? JSON.parse(buildConfigJson) : null;

        const loader = getLuaScriptLoader();
        const result = await loader.executeScript(
            'checkTimeout.lua',
            [],
            [
                String(buildId),
                String(jobId),
                String(startTime),
                String(timeout || DEFAULT_TIMEOUT),
                String(Date.now()),
                queuePrefix,
                runningJobsPrefix,
                waitingJobsPrefix
            ]
        );

        const decision = JSON.parse(result);

        logger.info(`worker[${workerId}] -> Build ${buildId}: action=${decision.action}, reason=${decision.reason}`);

        await handleDecision(decision, buildId, redis, workerId, buildConfig);
    } catch (err) {
        logger.error(`Error in timeout check for build ${buildId}: ${err.message}`);
        logger.error(err.stack);

        // Delete key from redis in case of error to prevent reprocessing
        await redis.hdel(hash, buildId);
    }
}

/**
 * Check if the build has timed out
 * If yes, abort build.
 * @method check
 * @param {Object} redis
 * @param {String} workerId
 * @return {Promise}
 */
async function check(redis, workerId) {
    const keys = await redis.hkeys(hash);

    if (!keys || keys.length === 0) return;

    await Promise.all(
        keys.map(async buildId => {
            try {
                const json = await redis.hget(hash, buildId);

                if (!json) return;
                const timeoutConfig = JSON.parse(json);

                if (!timeoutConfig) {
                    // this build or pipeline has already been deleted
                    return;
                }

                await process(timeoutConfig, buildId, redis, workerId);
            } catch (err) {
                logger.error(`worker[${workerId}] -> Error checking timeout for build ${buildId}: ${err.message}`);
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
 * Check timeouts with backoff to avoid excessive polling
 *
 * @param {Object} redis
 * @param {Number} workerId
 * @param {Number} [pollInterval]
 */
async function checkWithBackOff(redis, workerId, pollInterval = 60) {
    workerAccessMap[workerId] = workerAccessMap[workerId] || new Date();
    const diffMs = new Date().getTime() - new Date(workerAccessMap[workerId]).getTime();
    const diffSeconds = Math.round(diffMs / 1000);

    // poll every 60 seconds
    if (diffSeconds >= pollInterval) {
        logger.info('worker[%s] -> Processing timeout checks', workerId);
        workerAccessMap[workerId] = new Date();
        await check(redis, workerId);
    }
}

module.exports.checkWithBackOff = checkWithBackOff;
