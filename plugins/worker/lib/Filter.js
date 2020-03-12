'use strict';

const NodeResque = require('node-resque');
const { queuePrefix } = require('../../../config/redis');
const rabbitmqConf = require('../../../config/rabbitmq');

class Filter extends NodeResque.Plugin {
    /**
     * Construct a new Filter plugin
     * @method constructor
     */
    constructor(worker, func, queue, job, args, options) {
        super(worker, func, queue, job, args, options);

        this.name = 'Filter';
    }

    /**
     * Checks if the job belongs to this queue-worker
     * If no, re-enqueue.
     * @method beforePerform
     * @return {Promise}
     */
    async beforePerform() {
        const { buildId } = this.args[0];
        const buildConfig = await this.queueObject.connection.redis
            .hget(`${queuePrefix}buildConfigs`, buildId)
            .then(JSON.parse);

        if (!buildConfig) {
            // this build or pipeline has already been deleted
            return false;
        }

        // if schedulerMode enabled, don't take anything without buildClusterName
        if (rabbitmqConf.getConfig().schedulerMode) {
            if (!buildConfig.buildClusterName) {
                await this.reEnqueue();

                return false;
            }

            return true;
        }

        if (buildConfig.buildClusterName) {
            await this.reEnqueue();

            return false;
        }

        return true;
    }

    /**
     * Re-enqueue job if it doesn't belong to this queue worker
     * @method reEnqueue
     * @return {Promise}
     */
    async reEnqueue() {
        await this.queueObject.enqueueIn(this.reenqueueTimeout(), this.queue, this.func, this.args);
    }

    reenqueueTimeout() {
        if (this.options.enqueueTimeout) {
            return this.options.enqueueTimeout;
        }

        return 1000; // in ms
    }
}

exports.Filter = Filter;
