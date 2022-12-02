'use strict';

const Config = require('config');
const logger = require('screwdriver-logger');
const configSchema = require('screwdriver-data-schema').config;
const TOKEN_CONFIG_SCHEMA = configSchema.tokenConfig;
const { merge, reach } = require('@hapi/hoek');
const { MultiWorker, Scheduler, Plugins } = require('node-resque');
const cron = require('./utils/cron');
const helper = require('../helper');
const { timeOutOfWindows } = require('./utils/freezeWindows');
const { queueNamespace } = require('../../config/redis');
const ecosystem = Config.get('ecosystem');
const periodicBuildTableEnabled = helper.convertToBool(Config.get('queue').periodicBuildTableEnabled);
const DEFAULT_BUILD_TIMEOUT = 90;
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;
const EXPIRE_TIME = 1800; // 30 mins
const TEMPORAL_TOKEN_TIMEOUT = 12 * 60; // 12 hours in minutes
const TEMPORAL_UNZIP_TOKEN_TIMEOUT = 2 * 60; // 2 hours in minutes
const BLOCKED_BY_SAME_JOB_WAIT_TIME = 5;

/**
 * Posts a new build event to the API
 * @method postBuildEvent
 * @param {Object} eventConfig           Configuration
 * @param {Number} [eventConfig.eventId] Optional Parent event ID (optional)
 * @param {Object} eventConfig.pipeline  Pipeline of the job
 * @param {Object} eventConfig.job       Job object to create periodic builds for
 * @param {String} eventConfig.apiUri    Base URL of the Screwdriver API
 * @return {Promise}
 */
async function postBuildEvent(executor, eventConfig) {
    const { pipeline, job, apiUri, eventId, causeMessage, buildId } = eventConfig;
    const pipelineId = pipeline.id;
    const jobId = job.id;

    try {
        const token = executor.tokenGen({
            pipelineId,
            service: 'queue',
            jobId,
            scmContext: pipeline.scmContext,
            scope: ['user']
        });

        const admin = await helper.getPipelineAdmin(token, apiUri, pipelineId, helper.requestRetryStrategy);

        logger.info(
            `POST event for pipeline ${pipelineId}:${job.name}:${job.id}:${buildId} using user ${admin.username}`
        );

        const jwt = executor.userTokenGen(admin.username, {}, admin.scmContext);

        const buildEvent = {
            pipelineId,
            startFrom: job.name,
            creator: {
                name: 'Screwdriver scheduler',
                username: 'sd:scheduler'
            },
            causeMessage: causeMessage || 'Automatically started by scheduler'
        };

        if (eventId) {
            buildEvent.parentEventId = eventId;
        }
        if (buildId) {
            buildEvent.buildId = buildId;
        }

        await helper.createBuildEvent(apiUri, jwt, buildEvent, helper.requestRetryStrategyPostEvent);
    } catch (err) {
        if (err.statusCode === 404) {
            logger.error(
                `POST event for pipeline failed as no admin found: ${pipelineId}:${job.name}:${job.id}:${buildId}`
            );

            const pipelineToken = executor.tokenGen({
                pipelineId,
                service: 'queue',
                scmContext: pipeline.scmContext,
                scope: ['pipeline']
            });

            const status = 'FAILURE';
            const message = `Pipeline ${pipelineId} does not have admin, unable to start job ${job.name}.`;

            await helper.notifyJob(
                {
                    token: pipelineToken,
                    apiUri,
                    jobId,
                    payload: { status, message }
                },
                helper.requestRetryStrategyPostEvent
            );
        }

        logger.error(`Error in post build event function ${buildId} ${err}`);
        throw err;
    }
}

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

    if (periodicBuildTableEnabled) {
        return executor.redisBreaker.runCommand('hdel', executor.periodicBuildTable, config.jobId);
    }

    return Promise;
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
 * Calls postBuildEvent() with job configuration
 * @async startFrozen
 * @param {Object} config       Configuration
 * @return {Promise}
 */
async function startFrozen(executor, config) {
    try {
        const newConfig = {
            job: {
                name: config.jobName
            },
            causeMessage: 'Started by freeze window scheduler'
        };

        if (config.jobState === 'DISABLED' || config.jobArchived === true) {
            logger.error(`job ${config.jobName} is disabled or archived`);

            return Promise.resolve();
        }

        Object.assign(newConfig, config);

        return await postBuildEvent(executor, newConfig);
    } catch (err) {
        logger.error(`frozen builds: failed to post build event for job ${config.jobId}:${config.pipeline.id} ${err}`);

        return Promise.resolve();
    }
}

/**
 * Starts a new periodic build in an executor
 * @method startPeriodic
 * @param {Object}   config              Configuration
 * @param {Object}   config.pipeline     Pipeline of the job
 * @param {Object}   config.job          Job object to create periodic builds for
 * @param {String}   config.apiUri       Base URL of the Screwdriver API
 * @param {Boolean}  config.isUpdate     Boolean to determine if updating existing periodic build
 * @param {Boolean}  config.triggerBuild Flag to post new build event
 * @return {Promise}
 */
async function startPeriodic(executor, config) {
    const { pipeline, job, isUpdate, triggerBuild } = config;
    // eslint-disable-next-line max-len
    const buildCron = reach(job, 'permutations>0>annotations>screwdriver.cd/buildPeriodically', { separator: '>' });

    if (isUpdate) {
        await stopPeriodic(executor, { jobId: job.id });
    }

    if (triggerBuild) {
        config.causeMessage = 'Started by periodic build scheduler';
    }

    if (buildCron && job.state === 'ENABLED' && !job.archived) {
        await executor.connect();

        const next = cron.next(cron.transform(buildCron, job.id));

        if (periodicBuildTableEnabled) {
            try {
                // Store the config in redis
                await executor.redisBreaker.runCommand(
                    'hset',
                    executor.periodicBuildTable,
                    job.id,
                    JSON.stringify(
                        Object.assign(config, {
                            isUpdate: false,
                            triggerBuild: false
                        })
                    )
                );
            } catch (err) {
                logger.error(`failed to store the config in Redis for job ${job.id}: ${err}`);
            }
        }

        // Note: arguments to enqueueAt are [timestamp, queue name, job name, array of args]
        let shouldRetry = false;

        try {
            await executor.queue.enqueueAt(next, executor.periodicBuildQueue, 'startDelayed', [{ jobId: job.id }]);
        } catch (err) {
            // Error thrown by node-resque if there is duplicate: https://github.com/taskrabbit/node-resque/blob/master/lib/queue.js#L65
            // eslint-disable-next-line max-len
            if (err && err.message !== 'Job already enqueued at this time with same arguments') {
                shouldRetry = true;
                logger.warn(`duplicate build: failed to enqueue for job ${job.id}: ${err}`);
            } else {
                logger.error(`failed to enqueue for job ${job.id}: ${err}`);
            }
        }

        if (shouldRetry) {
            try {
                await executor.queue.enqueueAt(next, executor.periodicBuildQueue, 'startDelayed', [{ jobId: job.id }]);
            } catch (err) {
                logger.error(`failed to add to delayed queue for job ${job.id}: ${err}`);
            }
        } else {
            logger.info(`successfully added to queue for job ${job.id}`);
        }
    }
    logger.info(`added to delayed queue for job ${job.id}`);

    if (triggerBuild && (periodicBuildTableEnabled || !job.archived)) {
        try {
            await postBuildEvent(executor, config);
        } catch (err) {
            logger.error(
                `periodic builds: failed to post build event for job ${job.id} in pipeline ${pipeline.id}: ${err}`
            );
        }
    }

    return Promise.resolve();
}

/**
 * Starts a new build in an executor
 * @async  start
 * @param  {Object} config               Configuration
 * @param  {Object} [config.annotations] Optional key/value object
 * @param  {Number} [config.eventId]     Optional eventID that this build belongs to
 * @param  {String} config.build         Build object
 * @param  {Array}  config.blockedBy     Array of job IDs that this job is blocked by. Always blockedby itself
 * @param  {String} config.causeMessage  Reason the event is run
 * @param  {Array}  config.freezeWindows Array of cron expressions that this job cannot run during
 * @param  {String} config.apiUri        Screwdriver's API
 * @param  {String} config.jobId         JobID that this build belongs to
 * @param  {String} config.jobName       Name of job that this build belongs to
 * @param  {String} config.jobState      ENABLED/DISABLED
 * @param  {String} config.jobArchived   Boolean value of whether job is archived
 * @param  {String} config.buildId       Unique ID for a build
 * @param  {Object} config.pipeline      Pipeline of the job
 * @param  {Fn}     config.tokenGen      Function to generate JWT from username, scope and scmContext
 * @param  {String} config.container     Container for the build to run in
 * @param  {String} config.token         JWT to act on behalf of the build
 * @return {Promise}
 */
async function start(executor, config) {
    await executor.connect();

    const {
        build,
        buildId,
        causeMessage,
        jobId,
        jobState,
        jobArchived,
        blockedBy,
        freezeWindows,
        apiUri,
        pipeline,
        isPR,
        prParentJobId
    } = config;
    const forceStart = /\[(force start)\]/.test(causeMessage);

    delete config.build;
    delete config.causeMessage;

    await stopFrozen(executor, {
        jobId
    });

    // Skip if job is disabled or archived
    if (jobState === 'DISABLED' || jobArchived === true) {
        return Promise.resolve();
    }

    const currentTime = new Date();
    const origTime = new Date(currentTime.getTime());

    timeOutOfWindows(freezeWindows, currentTime);

    let enq;
    const buildStats = build && build.stats;

    // for backward compatibility
    if (buildStats) {
        // need to reassign so the field can be dirty
        build.stats = merge(build.stats, {
            queueEnterTime: new Date().toISOString()
        });
    }

    const tokenConfig = {
        username: buildId,
        buildId,
        jobId,
        eventId: build && build.eventId,
        isPR
    };

    if (pipeline) {
        Object.assign(tokenConfig, {
            pipelineId: pipeline.id,
            scmContext: pipeline.scmContext,
            configPipelineId: pipeline.configPipelineId
        });
    }
    if (prParentJobId) {
        tokenConfig.prParentJobId = prParentJobId;
    }

    const buildToken = executor.tokenGen({ ...tokenConfig, scope: ['build'] });

    // Check freeze window
    if (currentTime.getTime() > origTime.getTime() && !forceStart) {
        const payload = {
            status: 'FROZEN',
            statusMessage: `Blocked by freeze window, re-enqueued to ${currentTime}`
        };

        if (buildStats) {
            payload.stats = build.stats;
        }

        await helper
            .updateBuild(
                {
                    buildId,
                    token: buildToken,
                    apiUri,
                    payload
                },
                helper.requestRetryStrategy
            )
            .catch(err => {
                logger.error(`frozenBuilds: failed to update build status for build ${buildId}: ${err}`);

                throw err;
            });

        // Remove old job from queue to collapse builds
        await executor.queueBreaker.runCommand('delDelayed', executor.frozenBuildQueue, 'startFrozen', [
            {
                jobId
            }
        ]);

        await executor.redisBreaker.runCommand('hset', executor.frozenBuildTable, jobId, JSON.stringify(config));

        // Add new job back to queue
        enq = await executor.queueBreaker.runCommand(
            'enqueueAt',
            currentTime.getTime(),
            executor.frozenBuildQueue,
            'startFrozen',
            [
                {
                    jobId
                }
            ]
        );
    } else {
        // validate schema for temporal token
        const value = TOKEN_CONFIG_SCHEMA.validate(tokenConfig);

        if (value.error) {
            logger.error('Failed to validate token config schema %s %s', buildId, jobId);

            throw value.error;
        }

        const token = executor.tokenGen(Object.assign(tokenConfig, { scope: ['temporal'] }), TEMPORAL_TOKEN_TIMEOUT);

        // set the start time in the queue
        Object.assign(config, { token });
        // Store the config in redis
        await executor.redisBreaker.runCommand('hset', executor.buildConfigTable, buildId, JSON.stringify(config));

        const blockedBySameJob = reach(config, 'annotations>screwdriver.cd/blockedBySameJob', {
            separator: '>',
            default: true
        });
        const blockedBySameJobWaitTime = reach(config, 'annotations>screwdriver.cd/blockedBySameJobWaitTime', {
            separator: '>',
            default: BLOCKED_BY_SAME_JOB_WAIT_TIME
        });

        // Note: arguments to enqueue are [queue name, job name, array of args]
        enq = await executor.queueBreaker.runCommand('enqueue', executor.buildQueue, 'start', [
            {
                buildId,
                jobId,
                blockedBy: blockedBy.toString(),
                blockedBySameJob,
                blockedBySameJobWaitTime
            }
        ]);
        if (buildStats) {
            await helper
                .updateBuild(
                    {
                        buildId,
                        token: buildToken,
                        apiUri,
                        payload: { stats: build.stats, status: 'QUEUED' }
                    },
                    helper.requestRetryStrategy
                )
                .catch(err => {
                    logger.error(`Failed to update build status for build ${buildId}: ${err}`);

                    throw err;
                });
        }
    }

    return enq;
}

/**
 * Intializes the scheduler and multiworker
 * @async  init
 * @param {Object} executor
 * @return {Promise}
 */
async function init(executor) {
    if (executor.multiWorker) return 'Scheduler running';

    const resqueConnection = { redis: executor.redis, namespace: queueNamespace };
    const retryOptions = {
        plugins: [Plugins.Retry],
        pluginOptions: {
            Retry: {
                retryLimit: RETRY_LIMIT,
                retryDelay: RETRY_DELAY
            }
        }
    };
    // Jobs object to register the worker with
    const jobs = {
        startDelayed: {
            perform: async config => {
                try {
                    const { jobId } = config;

                    logger.info(`Started processing periodic job ${jobId}`);

                    let fullConfig;

                    if (periodicBuildTableEnabled) {
                        const periodicBuildConfig = await executor.redisBreaker.runCommand(
                            'hget',
                            executor.periodicBuildTable,
                            jobId
                        );

                        fullConfig = Object.assign(JSON.parse(periodicBuildConfig), {
                            triggerBuild: true
                        });
                    } else {
                        const apiUri = ecosystem.api;

                        const buildToken = executor.tokenGen({
                            jobId,
                            service: 'queue',
                            scope: ['build']
                        });

                        const job = await helper.getJobConfig({
                            jobId,
                            token: buildToken,
                            apiUri
                        });

                        const pipelineToken = executor.tokenGen({
                            pipelineId: job.pipelineId,
                            service: 'queue',
                            scope: ['pipeline']
                        });

                        const pipeline = await helper.getPipelineConfig({
                            pipelineId: job.pipelineId,
                            token: pipelineToken,
                            apiUri
                        });

                        fullConfig = {
                            pipeline,
                            job,
                            apiUri,
                            isUpdate: false,
                            triggerBuild: true
                        };
                    }

                    return await startPeriodic(executor, fullConfig);
                } catch (err) {
                    logger.error(`err in startDelayed job: ${err}`);
                    throw err;
                }
            },
            ...retryOptions
        },
        startFrozen: {
            perform: async jobConfig => {
                try {
                    logger.info(`Started processing frozen job ${jobConfig.jobId}`);

                    const fullConfig = await executor.redisBreaker.runCommand(
                        'hget',
                        executor.frozenBuildTable,
                        jobConfig.jobId
                    );

                    return await startFrozen(executor, JSON.parse(fullConfig));
                } catch (err) {
                    logger.error(`err in startFrozen job: ${err}`);
                    throw err;
                }
            },
            ...retryOptions
        }
    };

    executor.multiWorker = new MultiWorker(
        {
            connection: resqueConnection,
            queues: [executor.periodicBuildQueue, executor.frozenBuildQueue],
            minTaskProcessors: 1,
            maxTaskProcessors: 10,
            checkTimeout: 1000,
            maxEventLoopDelay: 10,
            toDisconnectProcessors: true
        },
        jobs
    );

    executor.scheduler = new Scheduler({ connection: resqueConnection });

    executor.multiWorker.on('start', workerId => logger.info(`worker[${workerId}] started`));
    executor.multiWorker.on('end', workerId => logger.info(`worker[${workerId}] ended`));
    executor.multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
        logger.info(`cleaning old worker ${worker} pid ${pid}`)
    );
    executor.multiWorker.on('job', (workerId, queue, job) =>
        logger.info(`worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`)
    );
    executor.multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
        logger.info(`worker[${workerId}] reEnqueue job (${plugin}) ${queue} ${JSON.stringify(job)}`)
    );
    executor.multiWorker.on('success', (workerId, queue, job, result, duration) =>
        logger.info(`worker[${workerId}] job success ${queue} ${JSON.stringify(job)} >> ${result} (${duration}ms)`)
    );
    executor.multiWorker.on('failure', (workerId, queue, job, failure, duration) =>
        logger.info(`worker[${workerId}] job failure ${queue} ${JSON.stringify(job)} >> ${failure} (${duration}ms)`)
    );
    executor.multiWorker.on('error', (workerId, queue, job, error) =>
        logger.error(`worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`)
    );

    executor.scheduler.on('start', () => logger.info('scheduler started'));
    executor.scheduler.on('end', () => logger.info('scheduler ended'));
    executor.scheduler.on('leader', () => logger.info(`scheduler became leader`));
    executor.scheduler.on('error', error => logger.info(`scheduler error >> ${error}`));
    executor.scheduler.on('workingTimestamp', timestamp => logger.info(`scheduler working timestamp ${timestamp}`));
    executor.scheduler.on('cleanStuckWorker', (workerName, errorPayload, delta) =>
        logger.info(`scheduler failing ${workerName} (stuck for ${delta}s) and failing job ${errorPayload}`)
    );
    executor.scheduler.on('transferredJob', (timestamp, job) =>
        logger.info(`scheduler enqueuing job ${timestamp}  >>  ${JSON.stringify(job)}`)
    );

    await executor.multiWorker.start();
    await executor.scheduler.connect();
    await executor.scheduler.start();

    return 'Scheduler started';
}

/**
 * Adds start time of a build to timeout queue
 * @method startTimer
 * @param  {Object} config               Configuration
 * @param  {String} config.buildId       Unique ID for a build
 * @param  {String} config.startTime     Start time fo build
 * @param  {String} config.buildStatus     Status of build
 * @return {Promise}
 */
async function startTimer(executor, config) {
    try {
        await executor.connect();
        const { buildId, jobId, buildStatus, startTime } = config;

        if (buildStatus === 'RUNNING') {
            const buildTimeout = reach(config, 'annotations>screwdriver.cd/timeout', { separator: '>' });

            const value = parseInt(buildTimeout, 10);
            const timeout = Number.isNaN(value) ? DEFAULT_BUILD_TIMEOUT : value;

            const data = await executor.redisBreaker.runCommand('hget', executor.timeoutQueue, buildId);

            if (data) {
                return Promise.resolve();
            }

            return await executor.redisBreaker.runCommand(
                'hset',
                executor.timeoutQueue,
                buildId,
                JSON.stringify({
                    jobId,
                    startTime,
                    timeout
                })
            );
        }

        return Promise.resolve();
    } catch (err) {
        logger.error(`Error occurred while saving to timeout queue ${err}`);

        return Promise.resolve();
    }
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

/**
 * Cleanup any related processing
 */
async function cleanUp(executor) {
    try {
        await executor.multiWorker.end();
        await executor.scheduler.end();
        await executor.queue.end();
    } catch (err) {
        logger.error(`failed to end executor queue: ${err}`);
    }
}

/**
 * Pushes a message to cache queue to clear it
 * @async  clearCache
 * @param {Object} executor
 * @param {Object} config
 */
async function clearCache(executor, config) {
    try {
        await executor.connect();

        return await executor.queueBreaker.runCommand('enqueue', executor.cacheQueue, 'clear', [
            {
                resource: 'caches',
                action: 'delete',
                prefix: executor.prefix,
                ...config
            }
        ]);
    } catch (err) {
        logger.error(`Error occurred while saving to cache queue ${err}`);

        throw err;
    }
}

/**
 * Pushes a message to unzip artifacts
 * @async  unzipArtifacts
 * @param  {Object} executor
 * @param  {Object} config               Configuration
 * @param  {String} config.buildId       Unique ID for a build
 * @return {Promise}
 */
async function unzipArtifacts(executor, config) {
    await executor.connect();
    const { buildId } = config;
    const tokenConfig = {
        username: buildId,
        scope: 'unzip_worker'
    };
    const token = executor.tokenGen(tokenConfig, TEMPORAL_UNZIP_TOKEN_TIMEOUT);

    const enq = await executor.queueBreaker.runCommand('enqueue', executor.unzipQueue, 'start', [
        {
            buildId,
            token
        }
    ]);

    return enq;
}

/**
 * Pushes webhooks to redis
 * @async  queueWebhook
 * @param  {Object} executor
 * @param  {Object} webhookConfig
 * @return {Promise}
 */
async function queueWebhook(executor, webhookConfig) {
    await executor.connect();

    return executor.queueBreaker.runCommand(
        'enqueue',
        executor.webhookQueue,
        'sendWebhook',
        JSON.stringify({
            webhookConfig,
            token: executor.tokenGen({
                service: 'queue',
                scope: ['webhook_worker']
            })
        })
    );
}

module.exports = {
    init,
    start,
    stop,
    startPeriodic,
    stopPeriodic,
    startFrozen,
    stopFrozen,
    startTimer,
    stopTimer,
    cleanUp,
    clearCache,
    unzipArtifacts,
    queueWebhook
};
