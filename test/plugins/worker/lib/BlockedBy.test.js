'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Plugin Test', () => {
    const BLOCK_TIMEOUT_BUFFER = 30;
    const jobId = 777;
    const buildId = 3;
    const mockJob = {};
    const mockFunc = () => {};
    const mockQueue = 'queuename';
    const runningJobsPrefix = 'mockRunningJobsPrefix_';
    const waitingJobsPrefix = 'mockRunningJobsPrefix_';
    let mockWorker;
    let mockArgs;
    let mockRedis;
    let mockLogger;
    let mockLuaScriptLoader;
    let BlockedBy;
    let blockedBy;
    let helperMock;
    let mockRedisConfig;
    let mockWorkerModule;

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
            lrem: sinon.stub().resolves(),
            on: sinon.stub()
        };

        mockLogger = {
            info: sinon.stub().resolves(),
            error: sinon.stub().resolves(),
            warn: sinon.stub().resolves()
        };

        mockLuaScriptLoader = {
            executeScript: sinon.stub()
        };

        mockWorkerModule = {
            luaScriptLoader: mockLuaScriptLoader
        };

        mockWorker = {
            workerId: 'test-worker-1',
            queueObject: {
                connection: {
                    redis: mockRedis
                },
                enqueueIn: sinon.stub().resolves()
            }
        };

        mockRedisConfig = {
            connectionDetails: {
                host: '127.0.0.1',
                options: {
                    password: 'test123',
                    tls: false
                },
                port: 1234,
                database: 0
            },
            runningJobsPrefix,
            waitingJobsPrefix,
            queuePrefix: 'mockQueue_'
        };

        helperMock = {
            updateBuildStatus: sinon.stub().resolves()
        };

        mockery.registerMock('screwdriver-logger', mockLogger);
        mockery.registerMock('../../../config/redis', mockRedisConfig);
        mockery.registerMock('../../helper', helperMock);
        mockery.registerMock('../worker', mockWorkerModule);

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
            it('proceeds if Lua script returns START action', async () => {
                // Mock Lua script to return START decision
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'READY',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
                assert.isTrue(mockLuaScriptLoader.executeScript.calledOnce);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('proceeds if this is a retry build', async () => {
                // Lua script detects retry and returns START
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'RETRY_BUILD',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
                assert.isTrue(mockLuaScriptLoader.executeScript.calledOnce);
            });

            it('proceeds if not blocked', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'NOT_BLOCKED',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('proceeds if not blocked and set block timeout based on build timeout', async () => {
                mockArgs[0].buildTimeout = 200;
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: true
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'NOT_BLOCKED',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
                // Verify timeout passed to Lua script includes buffer
                const scriptArgs = mockLuaScriptLoader.executeScript.firstCall.args[2];

                assert.equal(scriptArgs[8], String(200 + BLOCK_TIMEOUT_BUFFER));
            });

            it('proceeds if not blocked by self and others', async () => {
                mockArgs[0].blockedBy = '777';
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: false
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'NOT_BLOCKED_BY_SELF',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
            });

            it('do not proceed if build was aborted', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'ABORT',
                        reason: 'BUILD_ABORTED',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.notCalled(mockWorker.queueObject.enqueueIn);
            });

            it('do not proceed if build was aborted while running', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'ABORT',
                        reason: 'ABORTED_WHILE_RUNNING',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
            });

            it('do not block by self', async () => {
                mockArgs[0].blockedBy = '777';
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: false
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'SAME_JOB_NOT_BLOCKING',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
            });

            it('re-enqueue if blocked', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_BY_DEPENDENCIES',
                        buildId,
                        blockedBy: [111, 222]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
                assert.isTrue(
                    helperMock.updateBuildStatus.calledWith(
                        sinon.match({
                            buildId,
                            status: 'BLOCKED'
                        })
                    )
                );
            });

            it('re-enqueue if blocked multiple build ids', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_BY_DEPENDENCIES',
                        buildId,
                        blockedBy: [111, 222, 333]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('collapse waiting builds to latest one and re-enqueue if blocked', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'COLLAPSE',
                        reason: 'NEWER_BUILD_EXISTS',
                        buildId,
                        newestBuild: 5
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(
                    helperMock.updateBuildStatus.calledWith(
                        sinon.match({
                            buildId,
                            status: 'COLLAPSED',
                            statusMessage: 'Collapsed to build: 5'
                        })
                    )
                );
            });

            it('do not collapse if default collapse is false', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    collapse: false
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_BY_DEPENDENCIES',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                // Verify collapse flag was passed as false
                const scriptArgs = mockLuaScriptLoader.executeScript.firstCall.args[2];

                assert.equal(scriptArgs[3], 'false');
            });

            it('do not collapse build no longer in waiting queue', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'NOT_IN_WAITING_QUEUE',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('re-enqueue if blocked and no waiting builds', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_NO_WAITING',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('do not collapse if waiting build is the latest one', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'IS_LATEST_BUILD',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('collapse and discard build if older than last running build', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'COLLAPSE',
                        reason: 'OLDER_THAN_LAST_RUNNING',
                        buildId,
                        newestBuild: null
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(
                    helperMock.updateBuildStatus.calledWith(
                        sinon.match({
                            buildId,
                            status: 'COLLAPSED'
                        })
                    )
                );
            });

            it('do not collapse blocked build if user opts out', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    collapse: false
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'COLLAPSE_DISABLED',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('re-enqueue if blocked and not push to list if duplicate', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_DUPLICATE_NOT_ADDED',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('proceeds if same job waiting but not same buildId and feature is off', async () => {
                mockArgs[0].blockedBy = '777';
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockedBySelf: false
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'BLOCKED_BY_SELF_DISABLED',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
            });

            it('re-enqueue if there is the same job waiting but not the same buildId', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'SAME_JOB_DIFFERENT_BUILD',
                        buildId,
                        blockedBy: [777]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('proceeds if there is the same job waiting with same buildId', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'SAME_BUILD_ID',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
            });

            it('delete key if is the last job waiting', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'LAST_WAITING_JOB_DELETED',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isTrue(proceed);
            });

            it('use lockTimeout option for expiring key', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    blockTimeout: 150
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'START',
                        reason: 'NOT_BLOCKED',
                        buildId
                    })
                );

                await blockedBy.beforePerform();

                // Verify custom timeout passed to Lua script
                const scriptArgs = mockLuaScriptLoader.executeScript.firstCall.args[2];

                assert.equal(scriptArgs[8], '150');
            });

            it('use reenqueueWaitTime option for enqueueing', async () => {
                blockedBy = new BlockedBy(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {
                    reenqueueWaitTime: 5
                });

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_BY_DEPENDENCIES',
                        buildId,
                        blockedBy: [111]
                    })
                );

                await blockedBy.beforePerform();

                // Verify reenqueue time is 5 minutes (300000 ms)
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledWith(300000));
            });

            it('always collapse waiting builds to latest one and re-enqueue if blocked when updateBuildStatus error', async () => {
                helperMock.updateBuildStatus.rejects(new Error('update error'));

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'COLLAPSE',
                        reason: 'NEWER_BUILD_EXISTS',
                        buildId,
                        newestBuild: 5
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(helperMock.updateBuildStatus.calledOnce);
            });

            it('anyway collapse and discard build if older than last running build when updateBuildStatus error', async () => {
                helperMock.updateBuildStatus.rejects(new Error('update error'));

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'COLLAPSE',
                        reason: 'OLDER_THAN_LAST_RUNNING',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
            });

            it('anyway re-enqueue if blocked when updateBuildStatus error', async () => {
                helperMock.updateBuildStatus.rejects(new Error('update error'));

                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'BLOCK',
                        reason: 'BLOCKED_BY_DEPENDENCIES',
                        buildId,
                        blockedBy: [111]
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockWorker.queueObject.enqueueIn.calledOnce);
            });

            it('log error when Lua script fails', async () => {
                mockLuaScriptLoader.executeScript.rejects(new Error('Lua script error'));

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockLogger.error.calledWith(sinon.match(/Error in beforePerform/)));
            });

            it('handles unknown action gracefully', async () => {
                mockLuaScriptLoader.executeScript.resolves(
                    JSON.stringify({
                        action: 'UNKNOWN_ACTION',
                        reason: 'TEST',
                        buildId
                    })
                );

                const proceed = await blockedBy.beforePerform();

                assert.isFalse(proceed);
                assert.isTrue(mockLogger.error.calledWith(sinon.match(/Unknown action/)));
            });
        });

        describe('afterPerform', () => {
            it('proceeds', async () => {
                const result = await blockedBy.afterPerform();

                assert.isTrue(result);
            });
        });
    });
});
