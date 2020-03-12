'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Plugin Test', () => {
    const BLOCK_TIMEOUT_BUFFER = 30;
    const DEFAULT_BLOCKTIMEOUT = 120;
    const DEFAULT_ENQUEUETIME = 1;
    const jobId = 777;
    const buildId = 3;
    const buildIdStr = '3';
    const mockJob = {};
    const mockFunc = () => {};
    const mockQueue = 'queuename';
    const runningJobsPrefix = 'mockRunningJobsPrefix_';
    const waitingJobsPrefix = 'mockRunningJobsPrefix_';
    const queuePrefix = undefined;
    const deleteKey = `deleted_${jobId}_${buildId}`;
    const runningKey = `${runningJobsPrefix}777`;
    const key = `${runningJobsPrefix}${jobId}`;
    let mockWorker;
    let mockArgs;
    let mockRedis;
    let BlockedBy;
    let blockedBy;
    let helperMock;
    let mockRedisConfig;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockArgs = [
            {
                jobId,
                buildId,
                blockedBy: '111,222,777'
            }
        ];

        mockRedis = {
            hget: sinon.stub().resolves('{"apiUri": "foo.bar", "token": "fake"}'),
            hdel: sinon.stub().resolves(null),
            set: sinon.stub().resolves(),
            get: sinon.stub().resolves(null),
            expire: sinon.stub().resolves(),
            llen: sinon.stub().resolves(0),
            lpop: sinon.stub().resolves(),
            lrange: sinon.stub().resolves(['4', '5']),
            rpush: sinon.stub().resolves(),
            del: sinon.stub().resolves(),
            lrem: sinon.stub().resolves()
        };
        mockWorker = {
            queueObject: {
                connection: {
                    redis: mockRedis
                },
                enqueueIn: sinon.stub().resolves()
            }
        };
        mockRedisConfig = {
            runningJobsPrefix,
            waitingJobsPrefix
        };
        helperMock = {
            updateBuildStatus: sinon.stub()
        };

        mockery.registerMock('ioredis', mockRedis);
        mockery.registerMock('../../../config/redis', mockRedisConfig);
        mockery.registerMock('../../helper.js', helperMock);

        // eslint-disable-next-line global-require
        BlockedBy = require('../../../../plugins/worker/lib/BlockedBy').BlockedBy;

        blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
            blockedBySelf: true
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('BlockedBy', () => {
        it('constructor', async () => {
            assert.equal(blockedBy.name, 'BlockedBy');
        });

        describe('beforePerform', () => {
            beforeEach(() => {
                mockRedis.get.withArgs(deleteKey).resolves(null);
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves(null);
                mockRedis.get.withArgs(`${runningJobsPrefix}222`).resolves(null);
                mockRedis.get.withArgs(runningKey).resolves(null);
                mockRedis.get.withArgs(`last_${runningKey}`).resolves(null);
            });

            it('proceeds if this is a retry build', async () => {
                mockRedis.get.withArgs(runningKey).resolves(`${buildId}`);
                mockRedis.lrange.resolves([]);
                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
            });

            it('proceeds if not blocked', async () => {
                mockRedis.lrange.resolves([]);
                await blockedBy.beforePerform();
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.expire, key, DEFAULT_BLOCKTIMEOUT * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.calledWith(mockRedis.get, runningKey);
                assert.calledWith(mockRedis.get, deleteKey);
                assert.calledWith(mockRedis.get, `${runningJobsPrefix}111`);
                assert.calledWith(mockRedis.get, `${runningJobsPrefix}222`);
            });

            it('proceeds if not blocked and set block timeout based on build timeout', async () => {
                const buildConfig = {
                    apiUri: 'foo.bar',
                    token: 'fake',
                    annotations: {
                        'screwdriver.cd/timeout': 200
                    }
                };

                mockRedis.hget.resolves(JSON.stringify(buildConfig));
                mockRedis.lrange.resolves([]);
                await blockedBy.beforePerform();
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.expire, key, (200 + BLOCK_TIMEOUT_BUFFER) * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.calledWith(mockRedis.get, runningKey);
                assert.calledWith(mockRedis.get, deleteKey);
                assert.calledWith(mockRedis.get, `${runningJobsPrefix}111`);
                assert.calledWith(mockRedis.get, `${runningJobsPrefix}222`);
            });

            it('proceeds if not blocked by self and others', async () => {
                mockRedis.lrange.resolves([]);
                mockArgs[0].blockedBy = '777';
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: 'false'
                });
                await blockedBy.beforePerform();
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.expire, key, DEFAULT_BLOCKTIMEOUT * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.calledWith(mockRedis.get, runningKey);
            });

            it('do not proceed if build was aborted', async () => {
                mockRedis.get.withArgs(deleteKey).resolves('');
                const result = await blockedBy.beforePerform();

                assert.equal(result, false);
                assert.calledWith(mockRedis.get, runningKey);
                assert.calledWith(mockRedis.get, deleteKey);
                assert.calledWith(mockRedis.get, `${runningJobsPrefix}${jobId}`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.rpush);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.calledWith(mockRedis.lrem, `${waitingJobsPrefix}${jobId}`, 0, buildId);
            });

            it('do not proceed if build was aborted while running', async () => {
                mockRedis.get.withArgs(deleteKey).resolves('');
                mockRedis.get.withArgs(`${runningJobsPrefix}${jobId}`).resolves('4');
                const result = await blockedBy.beforePerform();

                assert.equal(result, false);
                assert.calledWith(mockRedis.get.firstCall, deleteKey);
                assert.calledWith(mockRedis.get.secondCall, `${runningJobsPrefix}${jobId}`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.rpush);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.calledWith(mockRedis.lrem, `${waitingJobsPrefix}${jobId}`, 0, buildId);
                assert.calledWith(mockRedis.del, deleteKey);
            });

            it('do not block by self', async () => {
                mockRedis.lrange.resolves([]);
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: 'false'
                });

                await blockedBy.beforePerform();
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.expire, key, DEFAULT_BLOCKTIMEOUT * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('re-enqueue if blocked', async () => {
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('re-enqueue if blocked multiple build ids', async () => {
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.get.withArgs(`${runningJobsPrefix}222`).resolves('456');

                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.equal(mockRedis.get.getCall(5).args[0], `${runningJobsPrefix}777`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage:
                        'Blocked by these running build(s): ' +
                        '<a href="/builds/123">123</a>, <a href="/builds/456">456</a>'
                });
            });

            it('collapse waiting builds to latest one and re-enqueue if blocked', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves(['2', '1']);
                mockRedis.lrem.resolves(1);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus.firstCall, {
                    buildId: 1,
                    redisInstance: mockRedis,
                    status: 'COLLAPSED',
                    statusMessage: 'Collapsed to build: 3'
                });
                assert.calledWith(helperMock.updateBuildStatus.secondCall, {
                    buildId: 2,
                    redisInstance: mockRedis,
                    status: 'COLLAPSED',
                    statusMessage: 'Collapsed to build: 3'
                });
                assert.calledWith(helperMock.updateBuildStatus.thirdCall, {
                    buildId,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('do not collapse if default collapse is false', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: false
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves(['2', '1']);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.lrem);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledOnce(helperMock.updateBuildStatus);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('do not collapse build no longer in waiting queue', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves(['2']);
                mockRedis.lrem.resolves(0);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledOnce(helperMock.updateBuildStatus);
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('re-enqueue if blocked and no waiting builds', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves([]);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.lrem);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('do not re-enqueue if build from the same event id', async () => {
                mockArgs = [
                    {
                        jobId,
                        buildId,
                        blockedBy: '3,4,5'
                    }
                ];
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                const buildConfig1 = {
                    apiUri: 'foo.bar',
                    token: 'fake',
                    annotations: {
                        'screwdriver.cd/timeout': 200,
                        'screwdriver.cd/collapseBuilds': false
                    },
                    eventId: '345',
                    jobId: '777'
                };

                const buildConfig2 = {
                    apiUri: 'foo.foo',
                    token: 'morefake',
                    annotations: {
                        'screwdriver.cd/timeout': 300,
                        'screwdriver.cd/collapseBuilds': false
                    },
                    eventId: '345',
                    jobId: '777'
                };

                const buildConfig3 = {
                    apiUri: 'bar.foo',
                    token: 'stillfake',
                    annotations: {
                        'screwdriver.cd/timeout': 500,
                        'screwdriver.cd/collapseBuilds': false
                    },
                    eventId: '344',
                    jobId: '111'
                };

                mockRedis.hget.withArgs(`${queuePrefix}buildConfigs`, buildId).resolves(JSON.stringify(buildConfig1));
                mockRedis.hget.withArgs(`${queuePrefix}buildConfigs`, '4').resolves(JSON.stringify(buildConfig2));
                mockRedis.hget.withArgs(`${queuePrefix}buildConfigs`, '5').resolves(JSON.stringify(buildConfig3));
                mockRedis.get.withArgs(`${runningJobsPrefix}3`).resolves('4');
                mockRedis.lrange.resolves(['3']);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}3`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}4`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.lrem);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('do not collapse if waiting build is the latest one', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves(['3']);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.lrem);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('collapse and discard build if older than last running build', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.get.withArgs(`last_${runningKey}`).resolves('4');
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.calledOnce(mockRedis.lrem);
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'COLLAPSED',
                    statusMessage: 'Collapsed to build: 4'
                });
            });

            it('do not collapse blocked build if user opts out', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                const buildConfig = {
                    apiUri: 'foo.bar',
                    token: 'fake',
                    annotations: {
                        'screwdriver.cd/timeout': 200,
                        'screwdriver.cd/collapseBuilds': false
                    }
                };

                mockRedis.hget.resolves(JSON.stringify(buildConfig));
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.get.withArgs(`last_${runningKey}`).resolves('4');
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.lrem);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/123">123</a>'
                });
            });

            it('do not re-enqueue if current build is older than waiting builds', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true,
                    collapse: true
                });
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves(['4']);
                helperMock.updateBuildStatus.yieldsAsync(null, {});
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.lrem);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('re-enqueue if blocked and not push to list if duplicate', async () => {
                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                mockRedis.lrange.resolves([buildIdStr]);
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.notCalled(mockRedis.rpush);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
            });

            it('proceeds if same job waiting but not same buildId and feature is off', async () => {
                mockRedis.lrange.resolves(['2']);
                mockRedis.llen.resolves(1);
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: 'false'
                });
                await blockedBy.beforePerform();
                assert.calledWith(mockRedis.del, `${waitingJobsPrefix}${jobId}`);
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.expire, key, DEFAULT_BLOCKTIMEOUT * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
                assert.notCalled(mockRedis.rpush);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('re-enqueue if there is the same job waiting but not the same buildId', async () => {
                mockRedis.lrange.resolves(['2']);
                mockRedis.llen.resolves(1);
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.notCalled(mockRedis.set);
                assert.notCalled(mockRedis.expire);
                assert.calledWith(mockRedis.rpush, `${waitingJobsPrefix}${jobId}`, buildId);
                assert.calledWith(
                    mockWorker.queueObject.enqueueIn,
                    DEFAULT_ENQUEUETIME * 1000 * 60,
                    mockQueue,
                    mockFunc,
                    mockArgs
                );
                assert.calledWith(helperMock.updateBuildStatus, {
                    buildId: 3,
                    redisInstance: mockRedis,
                    status: 'BLOCKED',
                    statusMessage: 'Blocked by these running build(s): <a href="/builds/2">2</a>' // blocked by itself
                });
            });

            it('proceeds if there is the same job waiting with same buildId', async () => {
                mockRedis.lrange.resolves(['5', '3', '4']);
                mockRedis.llen.resolves(2);
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.expire, key, DEFAULT_BLOCKTIMEOUT * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('delete key if is the last job waiting', async () => {
                mockRedis.lrange.resolves(['3']);
                mockRedis.llen.resolves(0);
                await blockedBy.beforePerform();
                assert.equal(mockRedis.get.getCall(0).args[0], deleteKey);
                assert.equal(mockRedis.get.getCall(1).args[0], runningKey);
                assert.equal(mockRedis.get.getCall(2).args[0], `last_${runningKey}`);
                assert.equal(mockRedis.get.getCall(3).args[0], `${runningJobsPrefix}111`);
                assert.equal(mockRedis.get.getCall(4).args[0], `${runningJobsPrefix}222`);
                assert.calledWith(mockRedis.set, key, buildId);
                assert.calledWith(mockRedis.lrem, `${waitingJobsPrefix}${jobId}`, 0, buildId);
                assert.calledWith(mockRedis.del, `${waitingJobsPrefix}${jobId}`);
                assert.calledWith(mockRedis.expire, key, DEFAULT_BLOCKTIMEOUT * 60);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('use lockTimeout option for expiring key', async () => {
                mockRedis.lrange.resolves([]);
                const blockTimeout = 1;

                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockTimeout
                });

                await blockedBy.beforePerform();
                assert.calledWith(mockRedis.expire, key, 60);
            });

            it('use reenqueueWaitTime option for enqueueing', async () => {
                const reenqueueWaitTime = 5;

                mockRedis.get.withArgs(`${runningJobsPrefix}111`).resolves('123');
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    reenqueueWaitTime
                });

                await blockedBy.beforePerform();
                assert.calledWith(mockWorker.queueObject.enqueueIn, 300000, mockQueue, mockFunc, mockArgs);
            });
        });

        describe('afterPerform', () => {
            it('proceeds', async () => {
                const proceed = await blockedBy.afterPerform();

                assert.equal(proceed, true);
            });
        });
    });
});
