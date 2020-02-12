'use strict';

const logger = require('screwdriver-logger');
const Redis = require('ioredis');
const Resque = require('node-resque');
const fuses = require('circuit-fuses');
const Breaker = fuses.breaker;
const FuseBox = fuses.box;
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;

module.exports = class ExecutorQueue {
    /**
     * Constructs a router for different Executor strategies.
     * @method constructor
     * @param  {Object}         config                      Object with executor and ecosystem
     * @param  {Object}         config.redisConnection      Connection details for redis
     * @param  {Object}         config.pipelineFactory      Pipeline Factory instance
     * @param  {String}         [config.prefix]             Prefix for queue name
     * @param  {Object}         [config.breaker]            Optional breaker config
     */
    constructor(config = {}) {
        if (!config.redisConnection) {
            throw new Error('No redis connection passed in');
        }
        if (!config.pipelineFactory) {
            throw new Error('No PipelineFactory instance passed in');
        }

        const breaker = Object.assign({}, config.breaker || {});

        this.prefix = config.prefix || '';
        this.buildQueue = `${this.prefix}builds`;
        this.periodicBuildQueue = `${this.prefix}periodicBuilds`;
        this.frozenBuildQueue = `${this.prefix}frozenBuilds`;
        this.buildConfigTable = `${this.prefix}buildConfigs`;
        this.periodicBuildTable = `${this.prefix}periodicBuildConfigs`;
        this.frozenBuildTable = `${this.prefix}frozenBuildConfigs`;
        this.tokenGen = null;
        this.userTokenGen = null;
        this.pipelineFactory = config.pipelineFactory;
        this.timeoutQueue = `${this.prefix}timeoutConfigs`;

        const redisConnection = Object.assign({}, config.redisConnection, { pkg: 'ioredis' });

        this.redis = new Redis(
            redisConnection.port,
            redisConnection.host,
            redisConnection.options
        );

        // eslint-disable-next-line new-cap
        this.queue = new Resque.Queue({ connection: redisConnection });
        this.queueBreaker = new Breaker((funcName, ...args) => {
            const callback = args.pop();

            this.queue[funcName](...args)
                .then((...results) => callback(null, ...results))
                .catch(callback);
        }, breaker);
        this.redisBreaker = new Breaker((funcName, ...args) =>
            // Use the queue's built-in connection to send redis commands instead of instantiating a new one
            this.redis[funcName](...args), breaker);
        this.requestRetryStrategy = (err, response) =>
            !!err || (response.statusCode !== 201 && response.statusCode !== 200);
        this.requestRetryStrategyPostEvent = (err, response) =>
            !!err || (response.statusCode !== 201 && response.statusCode !== 200
                && response.statusCode !== 404); // postEvent can return 404 if no job to start
        this.fuseBox = new FuseBox();
        this.fuseBox.addFuse(this.queueBreaker);
        this.fuseBox.addFuse(this.redisBreaker);

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
                        const fullConfig = await this.redisBreaker
                            .runCommand('hget', this.periodicBuildTable, jobConfig.jobId);

                        return await this.startPeriodic(
                            Object.assign(JSON.parse(fullConfig), { triggerBuild: true }));
                    } catch (err) {
                        logger.error('err in startDelayed job: ', err);
                        throw err;
                    }
                }
            }, retryOptions),
            startFrozen: Object.assign({
                perform: async (jobConfig) => {
                    try {
                        const fullConfig = await this.redisBreaker
                            .runCommand('hget', this.frozenBuildTable, jobConfig.jobId);

                        return await this.startFrozen(JSON.parse(fullConfig));
                    } catch (err) {
                        logger.error('err in startFrozen job: ', err);
                        throw err;
                    }
                }
            }, retryOptions)
        };

        // eslint-disable-next-line new-cap
        this.multiWorker = new Resque.MultiWorker({
            connection: redisConnection,
            queues: [this.periodicBuildQueue, this.frozenBuildQueue],
            minTaskProcessors: 1,
            maxTaskProcessors: 10,
            checkTimeout: 1000,
            maxEventLoopDelay: 10,
            toDisconnectProcessors: true
        }, jobs);
        // eslint-disable-next-line new-cap
        this.scheduler = new Resque.Scheduler({ connection: redisConnection });

        this.multiWorker.on('start', workerId =>
            info(`worker[${workerId}] started`));
        this.multiWorker.on('end', workerId =>
            info(`worker[${workerId}] ended`));
        this.multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
            info(`cleaning old worker ${worker} pid ${pid}`));
        this.multiWorker.on('job', (workerId, queue, job) =>
            info(`worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`));
        this.multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
            // eslint-disable-next-line max-len
            info(`worker[${workerId}] reEnqueue job (${plugin}) ${queue} ${JSON.stringify(job)}`));
        this.multiWorker.on('success', (workerId, queue, job, result) =>
            // eslint-disable-next-line max-len
            info(`worker[${workerId}] job success ${queue} ${JSON.stringify(job)} >> ${result}`));
        this.multiWorker.on('failure', (workerId, queue, job, failure) =>
            // eslint-disable-next-line max-len
            info(`worker[${workerId}] job failure ${queue} ${JSON.stringify(job)} >> ${failure}`));
        this.multiWorker.on('error', (workerId, queue, job, error) =>
            logger.error(`worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`));

        // multiWorker emitters
        this.multiWorker.on('internalError', error =>
            logger.error(error));

        this.scheduler.on('start', () =>
            info('scheduler started'));
        this.scheduler.on('end', () =>
            info('scheduler ended'));
        this.scheduler.on('master', state =>
            info(`scheduler became master ${state}`));
        this.scheduler.on('error', error =>
            info(`scheduler error >> ${error}`));
        this.scheduler.on('workingTimestamp', timestamp =>
            info(`scheduler working timestamp ${timestamp}`));
        this.scheduler.on('transferredJob', (timestamp, job) =>
            info(`scheduler enqueuing job timestamp  >>  ${JSON.stringify(job)}`));

        this.multiWorker.start();
        this.scheduler.connect().then(() => this.scheduler.start());
    }

    /**
     * Connect to the queue if we haven't already
     * @method connect
     * @return {Promise}
     */
    connect() {
        if (this.queue.connection.connected) {
            return Promise.resolve();
        }

        return this.queueBreaker.runCommand('connect');
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param {Response} Object     Object containing stats for the executor
     */
    stats() {
        return this.queueBreaker.stats();
    }
}