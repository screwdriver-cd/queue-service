'use strict';

const Resque = require('node-resque');
const fuses = require('circuit-fuses');
const Breaker = fuses.breaker;
const FuseBox = fuses.box;
const logger = require('screwdriver-logger');
const redis = require('../plugins/redis');

module.exports = class ExecutorQueue {
    /**
     * Constructs a router for different Executor strategies.
     * @method constructor
     * @param  {Object}         config                      Object with executor and ecosystem
     * @param  {Object}         config.redisConnection      Connection details for redis
     * @param  {String}         [config.prefix]             Prefix for queue name
     * @param  {Object}         [config.breaker]            Optional breaker config
     */
    constructor(config = {}) {
        if (!config.redisConnection) {
            throw new Error('No redis connection passed in');
        }

        const breakerOptions = { ...(config.breaker || {}) };

        this.prefix = config.prefix || '';
        this.buildQueue = `${this.prefix}builds`;
        this.periodicBuildQueue = `${this.prefix}periodicBuilds`;
        this.frozenBuildQueue = `${this.prefix}frozenBuilds`;
        this.buildConfigTable = `${this.prefix}buildConfigs`;
        this.periodicBuildTable = `${this.prefix}periodicBuildConfigs`;
        this.frozenBuildTable = `${this.prefix}frozenBuildConfigs`;
        this.tokenGen = null;
        this.userTokenGen = null;
        this.timeoutQueue = `${this.prefix}timeoutConfigs`;
        this.cacheQueue = `${this.prefix}cache`;
        this.unzipQueue = `${this.prefix}unzip`;
        this.webhookQueue = `${this.prefix}webhooks`;

        this.redis = redis;

        // eslint-disable-next-line new-cap
        this.queue = new Resque.Queue({ connection: { redis: this.redis } });
        this.queue.on('error', error => logger.info(`Resque queue error >> ${error}`));
        this.queueBreaker = new Breaker((funcName, ...args) => {
            const callback = args.pop();

            this.queue[funcName](...args)
                .then((...results) => callback(null, ...results))
                .catch(callback);
        }, breakerOptions);
        this.redisBreaker = new Breaker(
            (funcName, ...args) =>
                // Use the queue's built-in connection to send redis commands instead of instantiating a new one
                this.redis[funcName](...args),
            breakerOptions
        );
        this.fuseBox = new FuseBox();
        this.fuseBox.addFuse(this.queueBreaker);
        this.fuseBox.addFuse(this.redisBreaker);
    }

    /**
     * Connect to the queue if we haven't already
     * @method connect
     * @return {Promise}
     */
    connect() {
        try {
            if (this.queue.connection.connected) {
                return Promise.resolve();
            }

            return this.queueBreaker.runCommand('connect');
        } catch (err) {
            logger.error('Failed to connect to redis', err);
            throw err;
        }
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param {Response} Object     Object containing stats for the executor
     */
    stats() {
        return this.queueBreaker.stats();
    }
};
