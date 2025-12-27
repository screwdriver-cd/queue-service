'use strict';

const NodeResque = require('node-resque');
const logger = require('screwdriver-logger');
const helper = require('../../helper');
const { runningJobsPrefix, waitingJobsPrefix, queuePrefix } = require('../../../config/redis');

let luaScriptLoader;

/**
 * Get LuaScriptLoader instance (lazy loaded to avoid circular dependency)
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

const BLOCK_TIMEOUT_BUFFER = 30;

class BlockedBy extends NodeResque.Plugin {
    /**
     * Construct a new BlockedBy plugin
     * @method constructor
     */
    constructor(worker, func, queue, job, args, options) {
        super(worker, func, queue, job, args, options);

        this.name = 'BlockedBy';
    }

    /**
     * beforePerform
     * This method:
     * 1. Calls a single atomic Lua script (startBuild.lua)
     * 2. Handles the decision returned by the script
     * @method beforePerform
     * @return {Promise<Boolean>} true to proceed, false to stop
     */
    async beforePerform() {
        const buildConfig = this.args[0];
        const { jobId, buildId, blockedBy } = buildConfig;

        logger.info(`worker[${this.worker.workerId}] -> Checking build ${buildId} (job ${jobId})`);

        try {
            const loader = getLuaScriptLoader();
            const result = await loader.executeScript(
                'startBuild.lua',
                [],
                [
                    String(buildId),
                    String(jobId),
                    JSON.stringify(blockedBy || []),
                    String(this.options.collapse !== false), // collapseEnabled
                    String(this.options.blockedBySelf !== false), // blockedBySelf
                    queuePrefix,
                    runningJobsPrefix,
                    waitingJobsPrefix,
                    String(this.blockTimeout(buildConfig.buildTimeout))
                ]
            );

            const decision = JSON.parse(result);

            logger.info(
                `worker[${this.worker.workerId}] -> Build ${buildId}: action=${decision.action}, reason=${decision.reason}`
            );

            return await this.handleDecision(decision, buildConfig);
        } catch (err) {
            logger.error(`Error in beforePerform for build ${buildId}: ${err.message}`);
            logger.error(err.stack);

            return false;
        }
    }

    /**
     * Handle the decision from Lua script
     * @param {Object} decision - {action, reason, buildId, ...}
     * @param {Object} buildConfig - Build configuration
     * @return {Promise<Boolean>} true to proceed, false to stop
     */
    async handleDecision(decision, buildConfig) {
        const { buildId } = buildConfig;

        switch (decision.action) {
            case 'START':
                // Build can start - proceed!
                logger.info(`worker[${this.worker.workerId}] -> Build ${buildId} starting`);

                return true;

            case 'BLOCK':
                // Build is blocked - re-enqueue
                logger.info(`worker[${this.worker.workerId}] -> Build ${buildId} blocked: ${decision.reason}`);

                await this.reEnqueue(buildConfig, decision);

                return false;

            case 'COLLAPSE':
                // Build was collapsed - update status and don't proceed
                logger.info(`worker[${this.worker.workerId}] -> Build ${buildId} collapsed: ${decision.reason}`);

                await this.handleCollapse(buildConfig, decision);

                return false;

            case 'ABORT':
                // Build was aborted - don't proceed
                logger.info(`worker[${this.worker.workerId}] -> Build ${buildId} aborted`);

                return false;

            default:
                logger.error(`worker[${this.worker.workerId}] -> Unknown action: ${decision.action}`);

                return false;
        }
    }

    /**
     * Re-enqueue blocked build
     * @param {Object} buildConfig
     * @param {Object} decision
     */
    async reEnqueue(buildConfig, decision) {
        const { buildId } = buildConfig;
        const blockedByArray = decision.blockedBy || [];
        const runningBuildId = decision.runningBuildId;

        const allBlockingBuilds = [...blockedByArray];

        if (runningBuildId) {
            allBlockingBuilds.push(runningBuildId);
        }

        let statusMessage = 'Blocked by these running build(s): ';

        statusMessage += allBlockingBuilds
            .map(blockingBuildId => `<a href="/builds/${blockingBuildId}">${blockingBuildId}</a>`)
            .join(', ');

        // Re-enqueue in reenqueueWaitTime
        const waitTime = this.reenqueueWaitTime() * 1000 * 60; // Convert to ms

        await this.queueObject.enqueueIn(waitTime, this.queue, this.func, this.args);

        logger.info(
            `worker[${this.worker.workerId}] -> Build ${buildId} re-enqueued in ${this.reenqueueWaitTime()} minutes`
        );

        await helper
            .updateBuildStatus({
                redisInstance: this.queueObject.connection.redis,
                buildId,
                status: 'BLOCKED',
                statusMessage
            })
            .catch(err => {
                logger.error(`Failed to update build status to BLOCKED for build:${buildId}:${err}`);
            });
    }

    /**
     * Handle collapsed build
     * @param {Object} buildConfig
     * @param {Object} decision
     */
    async handleCollapse(buildConfig, decision) {
        const { buildId } = buildConfig;
        const newestBuild = decision.newestBuild;

        await helper
            .updateBuildStatus({
                redisInstance: this.queueObject.connection.redis,
                buildId,
                status: 'COLLAPSED',
                statusMessage: newestBuild ? `Collapsed to build: ${newestBuild}` : 'Collapsed',
                buildConfig
            })
            .catch(err => {
                logger.error(`Failed to update build status to COLLAPSED for build:${buildId}:${err}`);
            });

        logger.info(`worker[${this.worker.workerId}] -> Build ${buildId} collapsed successfully`);
    }

    /**
     * After perform
     * @method afterPerform
     * @return {Promise<Boolean>}
     */
    async afterPerform() {
        return true;
    }

    /**
     * Calculate block timeout
     * @param {Number} buildTimeout - Build timeout in minutes
     * @return {Number} Block timeout in minutes
     */
    blockTimeout(buildTimeout) {
        if (buildTimeout) {
            return buildTimeout + BLOCK_TIMEOUT_BUFFER;
        }

        if (this.options.blockTimeout) {
            return this.options.blockTimeout;
        }

        return 120; // in minutes
    }

    /**
     * Get re-enqueue wait time
     * @return {Number} Wait time in minutes
     */
    reenqueueWaitTime() {
        if (this.options.reenqueueWaitTime) {
            return this.options.reenqueueWaitTime;
        }

        return 1; // in minutes
    }
}

module.exports = { BlockedBy };
