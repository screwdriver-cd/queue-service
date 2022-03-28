'use strict';

/* eslint-disable no-underscore-dangle */

const chai = require('chai');
const util = require('util');
const { assert } = chai;
const mockery = require('mockery');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const testConnection = require('../../data/testConnection.json');
const testConfig = require('../../data/fullConfig.json');
const testPipeline = require('../../data/testPipeline.json');
const testJob = require('../../data/testJob.json');
const { buildId, jobId, blockedBy, blockedBySameJob, blockedBySameJobWaitTime } = testConfig;
const partialTestConfig = {
    buildId,
    jobId,
    blockedBy,
    blockedBySameJob,
    blockedBySameJobWaitTime
};
const partialTestDefaultConfig = {
    buildId,
    jobId,
    blockedBy: blockedBy.toString(),
    blockedBySameJob: true,
    blockedBySameJobWaitTime: 5
};
const partialTestStopConfigToString = {
    buildId,
    jobId,
    blockedBy: blockedBy.toString()
};
const testAdmin = {
    username: 'admin'
};
const TEMPORAL_TOKEN_TIMEOUT = 12 * 60; // 12 hours in minutes
const TEMPORAL_UNZIP_TOKEN_TIMEOUT = 2 * 60; // 2 hours in minutes

sinon.assert.expose(chai.assert, { prefix: '' });

describe('scheduler test', () => {
    let Executor;
    let executor;
    let multiWorker;
    let scheduler;
    let resqueMock;
    let queueMock;
    let redisMock;
    let spyMultiWorker;
    let spyScheduler;
    let redisConstructorMock;
    let cronMock;
    let freezeWindowsMock;
    let helperMock;
    let buildMock;
    let userTokenGen;
    let tokenGen;
    let testDelayedConfig;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        userTokenGen = sinon.stub().returns('admintoken');
        tokenGen = sinon.stub().returns('token');
        testDelayedConfig = {
            pipeline: testPipeline,
            job: testJob,
            apiUri: 'http://localhost'
        };
        multiWorker = function() {
            this.start = () => {};
            this.end = sinon.stub().resolves();
        };
        scheduler = function() {
            this.start = sinon.stub().resolves();
            this.connect = sinon.stub().resolves();
            this.end = sinon.stub().resolves();
        };
        util.inherits(multiWorker, EventEmitter);
        util.inherits(scheduler, EventEmitter);
        queueMock = {
            connect: sinon.stub().resolves(),
            enqueue: sinon.stub().resolves(),
            enqueueAt: sinon.stub().resolves(),
            del: sinon.stub().resolves(1),
            delDelayed: sinon.stub().resolves(1),
            connection: {
                connected: false
            },
            end: sinon.stub().resolves()
        };
        resqueMock = {
            Queue: sinon.stub().returns(queueMock),
            MultiWorker: multiWorker,
            Scheduler: scheduler
        };
        spyMultiWorker = sinon.spy(resqueMock, 'MultiWorker');
        spyScheduler = sinon.spy(resqueMock, 'Scheduler');
        redisMock = {
            hget: sinon.stub().yieldsAsync(),
            hdel: sinon.stub().yieldsAsync(),
            hset: sinon.stub().yieldsAsync(),
            set: sinon.stub().yieldsAsync(),
            expire: sinon.stub().yieldsAsync()
        };
        redisConstructorMock = sinon.stub().returns(redisMock);
        cronMock = {
            transform: sinon.stub().returns('H H H H H'),
            next: sinon.stub().returns(1500000)
        };
        freezeWindowsMock = {
            timeOutOfWindows: (windows, date) => date
        };

        helperMock = {
            getPipelineAdmin: sinon.stub().resolves(testAdmin),
            createBuildEvent: sinon.stub().resolves(),
            updateBuild: sinon.stub().resolves(),
            requestRetryStrategy: sinon.stub(),
            requestRetryStrategyPostEvent: sinon.stub()
        };
        buildMock = {
            eventId: 4566,
            update: sinon.stub().resolves({
                id: buildId
            })
        };

        mockery.registerMock('node-resque', resqueMock);
        mockery.registerMock('ioredis', redisConstructorMock);
        mockery.registerMock('./utils/cron', cronMock);
        mockery.registerMock('./utils/freezeWindows', freezeWindowsMock);
        mockery.registerMock('../helper', helperMock);

        /* eslint-disable global-require */
        scheduler = require('../../../plugins/queue/scheduler');
        Executor = require('../../../lib/queue');
        /* eslint-enable global-require */

        executor = new Executor({
            redisConnection: testConnection,
            breaker: {
                retry: {
                    retries: 1
                }
            }
        });

        executor.tokenGen = tokenGen;
        executor.userTokenGen = userTokenGen;
        scheduler.init(executor);
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('startPeriodic', () => {
        beforeEach(() => {});
        it("rejects if it can't establish a connection", function() {
            queueMock.connect.rejects(new Error("couldn't connect"));

            return scheduler.startPeriodic(executor, testDelayedConfig).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.instanceOf(err, Error);
                }
            );
        });

        it("doesn't call connect if there's already a connection", () => {
            queueMock.connection.connected = true;

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.notCalled(queueMock.connect);
            });
        });

        it('enqueues a new delayed job in the queue', () =>
            scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(
                    redisMock.hset,
                    'periodicBuildConfigs',
                    testJob.id,
                    JSON.stringify(testDelayedConfig)
                );
                assert.calledWith(cronMock.transform, '* * * * *', testJob.id);
                assert.calledWith(cronMock.next, 'H H H H H');
                assert.calledWith(queueMock.enqueueAt, 1500000, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
            }));

        it('do not enqueue the same delayed job in the queue', () => {
            const err = new Error('Job already enqueued at this time with same arguments');

            queueMock.enqueueAt = sinon.stub().rejects(err);

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.calledWith(cronMock.next, 'H H H H H');
                assert.calledOnce(queueMock.enqueueAt);
            });
        });

        it('stops and reEnqueues an existing job if isUpdate flag is passed', () => {
            testDelayedConfig.isUpdate = true;

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(
                    redisMock.hset,
                    'periodicBuildConfigs',
                    testJob.id,
                    JSON.stringify(testDelayedConfig)
                );
                assert.calledWith(queueMock.enqueueAt, 1500000, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
            });
        });

        it('stops but does not reEnqueue an existing job if it is disabled', () => {
            testDelayedConfig.isUpdate = true;
            testDelayedConfig.job.state = 'DISABLED';
            testDelayedConfig.job.archived = false;

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.notCalled(redisMock.hset);
                assert.notCalled(queueMock.enqueueAt);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
            });
        });

        it('stops but does not reEnqueue an existing job if it is archived', () => {
            testDelayedConfig.isUpdate = true;
            testDelayedConfig.job.state = 'ENABLED';
            testDelayedConfig.job.archived = true;

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.notCalled(redisMock.hset);
                assert.notCalled(queueMock.enqueueAt);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
            });
        });

        it('trigger build and do not enqueue next job if archived', () => {
            testDelayedConfig.isUpdate = true;
            testDelayedConfig.job.state = 'ENABLED';
            testDelayedConfig.job.archived = true;
            testDelayedConfig.triggerBuild = true;

            const options = [
                'http://localhost',
                'admintoken',
                {
                    causeMessage: 'Started by periodic build scheduler',
                    creator: { name: 'Screwdriver scheduler', username: 'sd:scheduler' },
                    pipelineId: testDelayedConfig.pipeline.id,
                    startFrom: testDelayedConfig.job.name
                },
                helperMock.requestRetryStrategyPostEvent
            ];

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.notCalled(redisMock.hset);
                assert.notCalled(queueMock.enqueueAt);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
                assert.calledOnce(executor.tokenGen);
                assert.calledOnce(helperMock.getPipelineAdmin);
                assert.calledOnce(executor.userTokenGen);
                assert.calledWith(helperMock.createBuildEvent, ...options);
            });
        });

        it('trigger build and enqueue next job', () => {
            testDelayedConfig.isUpdate = false;
            testDelayedConfig.job.state = 'ENABLED';
            testDelayedConfig.job.archived = false;
            testDelayedConfig.triggerBuild = true;

            const options = [
                'http://localhost',
                'admintoken',
                {
                    causeMessage: 'Started by periodic build scheduler',
                    creator: { name: 'Screwdriver scheduler', username: 'sd:scheduler' },
                    pipelineId: testDelayedConfig.pipeline.id,
                    startFrom: testDelayedConfig.job.name
                },
                helperMock.requestRetryStrategyPostEvent
            ];

            return scheduler.startPeriodic(executor, testDelayedConfig).then(() => {
                assert.notCalled(queueMock.delDelayed);
                assert.calledOnce(executor.userTokenGen);
                assert.calledOnce(helperMock.getPipelineAdmin);
                assert.calledWith(helperMock.createBuildEvent, ...options);
                assert.calledOnce(queueMock.connect);
                assert.calledWith(
                    redisMock.hset,
                    'periodicBuildConfigs',
                    testJob.id,
                    JSON.stringify(testDelayedConfig)
                );
                assert.calledWith(cronMock.transform, '* * * * *', testJob.id);
                assert.calledWith(cronMock.next, 'H H H H H');
                assert.calledWith(queueMock.enqueueAt, 1500000, 'periodicBuilds', 'startDelayed', [
                    {
                        jobId: testJob.id
                    }
                ]);
            });
        });
    });

    describe('start', () => {
        beforeEach(() => {
            executor.tokenGen.returns('buildToken');
        });
        it("rejects if it can't establish a connection", () => {
            queueMock.connect.rejects(new Error("couldn't connect"));

            return scheduler.start(executor, testConfig).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.instanceOf(err, Error);
                }
            );
        });

        it('enqueues a build and caches the config', () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            sandbox.useFakeTimers(dateNow);
            buildMock.stats = {};
            testConfig.build = buildMock;

            return scheduler.start(executor, testConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(redisMock.hset, 'buildConfigs', buildId, JSON.stringify(testConfig));
                assert.calledWith(queueMock.enqueue, 'builds', 'start', [partialTestDefaultConfig]);
                assert.calledTwice(executor.tokenGen);
                assert.calledWith(
                    helperMock.updateBuild,
                    {
                        buildId,
                        token: 'buildToken',
                        apiUri: 'http://api.com',
                        payload: { stats: buildMock.stats, status: 'QUEUED' }
                    },
                    helperMock.requestRetryStrategy
                );
                assert.equal(buildMock.stats.queueEnterTime, isoTime);
                sandbox.restore();
            });
        });

        it('fails to enqueue a build with validation error for tokenConfig', () => {
            const dateNow = Date.now();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            sandbox.useFakeTimers(dateNow);
            buildMock.stats = {};
            testConfig.build = buildMock;
            const newConfig = { ...testConfig };

            delete newConfig.isPR;

            return scheduler
                .start(executor, newConfig)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(err => {
                    assert.calledTwice(queueMock.connect);
                    assert.notCalled(redisMock.hset);
                    assert.notCalled(queueMock.enqueue);
                    assert.calledWith(executor.tokenGen, {
                        buildId: newConfig.buildId,
                        configPipelineId: newConfig.pipeline.configPipelineId,
                        eventId: buildMock.eventId,
                        isPR: newConfig.isPR,
                        jobId: newConfig.jobId,
                        pipelineId: newConfig.pipeline.id,
                        prParentJobId: newConfig.prParentJobId,
                        scmContext: newConfig.pipeline.scmContext,
                        scope: ['build'],
                        username: newConfig.buildId
                    });
                    assert.calledOnce(executor.tokenGen);
                    sandbox.restore();
                    assert.isNotNull(err);
                });
        });

        it('enqueues a build and when force start is on', () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            sandbox.useFakeTimers(dateNow);
            buildMock.stats = {};
            testConfig.build = buildMock;
            testConfig.causeMessage = '[force start] Need to push hotfix';

            return scheduler.start(executor, testConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(redisMock.hset, 'buildConfigs', buildId, JSON.stringify(testConfig));
                assert.calledWith(queueMock.enqueue, 'builds', 'start', [partialTestDefaultConfig]);
                assert.calledTwice(executor.tokenGen);
                assert.calledWith(executor.tokenGen, {
                    buildId: testConfig.buildId,
                    configPipelineId: testConfig.pipeline.configPipelineId,
                    eventId: buildMock.eventId,
                    isPR: testConfig.isPR,
                    jobId: testConfig.jobId,
                    pipelineId: testConfig.pipeline.id,
                    prParentJobId: testConfig.prParentJobId,
                    scmContext: testConfig.pipeline.scmContext,
                    scope: ['build'],
                    username: testConfig.buildId
                });
                assert.calledWith(
                    executor.tokenGen,
                    {
                        buildId: testConfig.buildId,
                        configPipelineId: testConfig.pipeline.configPipelineId,
                        eventId: buildMock.eventId,
                        isPR: testConfig.isPR,
                        jobId: testConfig.jobId,
                        pipelineId: testConfig.pipeline.id,
                        prParentJobId: testConfig.prParentJobId,
                        scmContext: testConfig.pipeline.scmContext,
                        scope: ['temporal'],
                        username: testConfig.buildId
                    },
                    TEMPORAL_TOKEN_TIMEOUT
                );
                assert.calledWith(
                    helperMock.updateBuild,
                    {
                        buildId,
                        token: 'buildToken',
                        apiUri: 'http://api.com',
                        payload: { stats: buildMock.stats, status: 'QUEUED' }
                    },
                    helperMock.requestRetryStrategy
                );
                assert.equal(buildMock.stats.queueEnterTime, isoTime);
                sandbox.restore();
            });
        });

        it('enqueues a build and with enqueueTime', () => {
            buildMock.stats = {};
            testConfig.build = buildMock;
            const config = { ...testConfig, enqueueTime: new Date() };

            return scheduler.start(executor, config).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(redisMock.hset, 'buildConfigs', buildId, JSON.stringify(config));
                assert.calledWith(queueMock.enqueue, 'builds', 'start', [partialTestDefaultConfig]);
            });
        });

        it('enqueues a build and caches the config', () =>
            scheduler.start(executor, testConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(redisMock.hset, 'buildConfigs', buildId, JSON.stringify(testConfig));
                assert.calledWith(queueMock.enqueue, 'builds', 'start', [partialTestDefaultConfig]);
            }));

        it("doesn't call connect if there's already a connection", () => {
            queueMock.connection.connected = true;

            return scheduler.start(executor, testConfig).then(() => {
                assert.notCalled(queueMock.connect);
                assert.calledWith(queueMock.enqueue, 'builds', 'start', [partialTestDefaultConfig]);
            });
        });
    });

    describe('startFrozen', () => {
        it('enqueues a delayed job if in freeze window', () => {
            mockery.resetCache();

            const freezeWindowsMockB = {
                timeOutOfWindows: (windows, date) => {
                    date.setUTCMinutes(date.getUTCMinutes() + 1);

                    return date;
                }
            };

            mockery.deregisterMock('./utils/freezeWindows');
            mockery.registerMock('./utils/freezeWindows', freezeWindowsMockB);

            /* eslint-disable global-require */
            scheduler = require('../../../plugins/queue/scheduler');
            Executor = require('../../../lib/queue');
            /* eslint-enable global-require */

            executor = new Executor({
                redisConnection: testConnection,
                breaker: {
                    retry: {
                        retries: 1
                    }
                }
            });

            executor.tokenGen = tokenGen;
            executor.userTokenGen = userTokenGen;

            const dateNow = new Date();

            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            sandbox.useFakeTimers(dateNow.getTime());

            executor.tokenGen.returns('buildToken');

            const options = {
                buildId: testConfig.buildId,
                token: 'buildToken',
                apiUri: 'http://api.com',
                payload: {
                    status: 'FROZEN',
                    statusMessage: sinon.match('Blocked by freeze window, re-enqueued to ')
                }
            };

            return scheduler.start(executor, testConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(queueMock.delDelayed, 'frozenBuilds', 'startFrozen', [
                    {
                        jobId
                    }
                ]);
                assert.calledWith(redisMock.hset, 'frozenBuildConfigs', jobId, JSON.stringify(testConfig));
                assert.calledWith(queueMock.enqueueAt, dateNow.getTime() + 60000, 'frozenBuilds', 'startFrozen', [
                    {
                        jobId
                    }
                ]);
                assert.calledWith(helperMock.updateBuild, options, helperMock.requestRetryStrategy);
                assert.calledOnce(executor.tokenGen);
                sandbox.restore();
            });
        });
    });

    describe('stop', () => {
        it("rejects if it can't establish a connection", function() {
            queueMock.connect.rejects(new Error("couldn't connect"));

            return scheduler.stop(executor, partialTestConfig).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.instanceOf(err, Error);
                }
            );
        });

        it('removes a start event from the queue and the cached buildconfig', () => {
            const deleteKey = `deleted_${jobId}_${buildId}`;
            const stopConfig = { started: false, ...partialTestStopConfigToString };

            return scheduler.stop(executor, partialTestConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestStopConfigToString]);
                assert.calledWith(redisMock.set, deleteKey, '');
                assert.calledWith(redisMock.expire, deleteKey, 1800);
                assert.calledWith(queueMock.enqueue, 'builds', 'stop', [stopConfig]);
            });
        });

        it('adds a stop event to the queue if no start events were removed', () => {
            queueMock.del.resolves(0);
            const stopConfig = { started: true, ...partialTestStopConfigToString };

            return scheduler.stop(executor, partialTestConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestStopConfigToString]);
                assert.calledWith(queueMock.enqueue, 'builds', 'stop', [stopConfig]);
            });
        });

        it('adds a stop event to the queue if it has no blocked job', () => {
            queueMock.del.resolves(0);
            const partialTestConfigUndefined = { ...partialTestStopConfigToString, blockedBy: undefined };
            const stopConfig = { started: true, ...partialTestConfigUndefined };

            return scheduler.stop(executor, partialTestConfigUndefined).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestConfigUndefined]);
                assert.calledWith(queueMock.enqueue, 'builds', 'stop', [stopConfig]);
            });
        });

        it("doesn't call connect if there's already a connection", () => {
            queueMock.connection.connected = true;

            return scheduler
                .stop(executor, {
                    ...partialTestConfig,
                    annotations: {
                        'beta.screwdriver.cd/executor': 'screwdriver-executor-k8s'
                    }
                })
                .then(() => {
                    assert.notCalled(queueMock.connect);
                    assert.calledWith(queueMock.del, 'builds', 'start', [partialTestStopConfigToString]);
                });
        });
    });

    describe('stopTimer', () => {
        it("does not reject if it can't establish a connection", async () => {
            queueMock.connect.rejects(new Error("couldn't connect"));
            try {
                await scheduler.stopTimer(executor, {});
            } catch (err) {
                assert.fail('Should not get here');
            }
        });

        it('removes a key from redis for the specified buildId if it exists', async () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId,
                jobId,
                startTime: isoTime
            };

            sandbox.useFakeTimers(dateNow);
            redisMock.hget.withArgs('timeoutConfigs', buildId).yieldsAsync(null, {
                buildId,
                jobId,
                startTime: isoTime
            });

            await scheduler.stopTimer(executor, timerConfig);

            assert.calledOnce(queueMock.connect);
            assert.calledWith(redisMock.hdel, 'timeoutConfigs', buildId);
            sandbox.restore();
        });

        it('hdel is not called if buildId does not exist in cache', async () => {
            redisMock.hget.withArgs('timeoutConfigs', buildId).yieldsAsync(null, null);

            await scheduler.stopTimer(executor, testConfig);
            assert.calledOnce(queueMock.connect);
            assert.notCalled(redisMock.hdel);
        });
    });

    describe('startTimer', () => {
        it("does not reject if it can't establish a connection", async () => {
            queueMock.connect.rejects(new Error("couldn't connect"));
            try {
                await scheduler.startTimer(executor, {});
            } catch (err) {
                assert.fail('Should not get here');
            }
        });

        it('adds a timeout key if status is RUNNING and caches the config', async () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId,
                jobId,
                buildStatus: 'RUNNING',
                startTime: isoTime
            };

            sandbox.useFakeTimers(dateNow);
            redisMock.hget.yieldsAsync(null, null);
            await scheduler.startTimer(executor, timerConfig);
            assert.calledOnce(queueMock.connect);
            assert.calledWith(
                redisMock.hset,
                'timeoutConfigs',
                buildId,
                JSON.stringify({
                    jobId,
                    startTime: isoTime,
                    timeout: 90
                })
            );
            sandbox.restore();
        });

        it('does not add a timeout key if status is !RUNNING', async () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId,
                jobId,
                buildStatus: 'QUEUED',
                startTime: isoTime
            };

            sandbox.useFakeTimers(dateNow);
            redisMock.hget.yieldsAsync(null, null);

            await scheduler.startTimer(executor, timerConfig);
            assert.calledOnce(queueMock.connect);
            assert.notCalled(redisMock.hset);
            sandbox.restore();
        });

        it('does not add a timeout key if buildId already exists', async () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId,
                jobId,
                buildStatus: 'QUEUED',
                startTime: isoTime
            };

            sandbox.useFakeTimers(dateNow);
            redisMock.hget.withArgs('timeoutConfigs', buildId).yieldsAsync({
                jobId,
                startTime: isoTime,
                timeout: 90
            });

            await scheduler.startTimer(executor, timerConfig);
            assert.calledOnce(queueMock.connect);
            assert.notCalled(redisMock.hset);
            sandbox.restore();
        });

        it('adds a timeout config with specific timeout when annotations present', async () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.createSandbox({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId,
                jobId,
                buildStatus: 'RUNNING',
                startTime: isoTime,
                annotations: {
                    'screwdriver.cd/timeout': 5
                }
            };

            sandbox.useFakeTimers(dateNow);
            redisMock.hget.yieldsAsync(null, null);
            await scheduler.startTimer(executor, timerConfig);
            assert.calledOnce(queueMock.connect);
            assert.calledWith(
                redisMock.hset,
                'timeoutConfigs',
                buildId,
                JSON.stringify({
                    jobId,
                    startTime: isoTime,
                    timeout: 5
                })
            );
            sandbox.restore();
        });
    });

    describe('cleanUp', () => {
        it('worker.end() is called', async () => {
            await scheduler.cleanUp(executor);
            assert.called(spyMultiWorker);
            assert.called(spyScheduler);
            assert.called(queueMock.end);
        });
    });

    describe('clearCache', () => {
        let cacheConfig;
        let cacheConfigMsg;

        beforeEach(() => {
            cacheConfig = { id: 123, scope: 'pipelines', buildClusters: [] };
            cacheConfigMsg = Object.assign(cacheConfig, { prefix: '', resource: 'caches', action: 'delete' });
        });
        it("rejects if it can't establish a connection", function() {
            queueMock.connect.rejects(new Error("couldn't connect"));

            return scheduler.clearCache(executor, { id: 123, scope: 'pipelines' }).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.instanceOf(err, Error);
                }
            );
        });

        it('adds a clearCache event to the queue', () => {
            return scheduler.clearCache(executor, cacheConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.enqueue, 'cache', 'clear', [cacheConfigMsg]);
            });
        });

        it("doesn't call connect if there's already a connection", () => {
            queueMock.connection.connected = true;

            return scheduler.clearCache(executor, cacheConfig).then(() => {
                assert.notCalled(queueMock.connect);
                assert.calledWith(queueMock.enqueue, 'cache', 'clear', [cacheConfigMsg]);
            });
        });
    });

    describe('unzipArtifacts', () => {
        let unzipConfig;
        let unzipConfigMsg;

        beforeEach(() => {
            executor.tokenGen.returns('unzipToken');
            unzipConfig = { buildId: 123 };
            unzipConfigMsg = { buildId: 123, token: 'unzipToken' };
        });

        it("rejects if it can't establish a connection", function() {
            queueMock.connect.rejects(new Error("couldn't connect"));

            return scheduler.unzipArtifacts(executor, unzipConfig).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.instanceOf(err, Error);
                }
            );
        });

        it('enqueues an unzip job', () => {
            return scheduler.unzipArtifacts(executor, unzipConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledOnce(executor.tokenGen);
                assert.calledWith(
                    executor.tokenGen,
                    {
                        username: unzipConfig.buildId,
                        scope: 'unzip_worker'
                    },
                    TEMPORAL_UNZIP_TOKEN_TIMEOUT
                );
                assert.calledWith(queueMock.enqueue, 'unzip', 'start', [unzipConfigMsg]);
            });
        });

        it("doesn't call connect if there's already a connection", () => {
            queueMock.connection.connected = true;

            return scheduler.unzipArtifacts(executor, unzipConfig).then(() => {
                assert.notCalled(queueMock.connect);
                assert.calledOnce(executor.tokenGen);
                assert.calledWith(
                    executor.tokenGen,
                    {
                        username: unzipConfig.buildId,
                        scope: 'unzip_worker'
                    },
                    TEMPORAL_UNZIP_TOKEN_TIMEOUT
                );
                assert.calledWith(queueMock.enqueue, 'unzip', 'start', [unzipConfigMsg]);
            });
        });
    });

    describe('queueWebhook', () => {
        let webhookConfig;

        beforeEach(() => {
            webhookConfig = { hookId: '72d3162e-cc78-11e3-81ab-4c9367dc0958' };
        });

        it("rejects if it can't establish a connection", function() {
            queueMock.connect.rejects(new Error("couldn't connect"));

            return scheduler.queueWebhook(executor, webhookConfig).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.instanceOf(err, Error);
                }
            );
        });

        it("doesn't call connect if there's already a connection", () => {
            queueMock.connection.connected = true;

            return scheduler.queueWebhook(executor, webhookConfig).then(() => {
                assert.notCalled(queueMock.connect);
            });
        });

        it('enqueues an webhook', () => {
            return scheduler.queueWebhook(executor, webhookConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledOnce(queueMock.enqueue);
                assert.calledWith(executor.tokenGen, {
                    service: 'queue',
                    scope: ['webhook_worker']
                });
                assert.calledWith(
                    queueMock.enqueue,
                    'webhooks',
                    'sendWebhook',
                    JSON.stringify({
                        webhookConfig,
                        token: 'token'
                    })
                );
            });
        });
    });
});
