'use strict';

const { assert } = require('chai');
const { RedisMemoryServer } = require('redis-memory-server');
const Redis = require('ioredis');
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

describe('Timeout test', () => {
    const queuePrefix = 'mockQueuePrefix_';
    const runningJobsPrefix = 'mockRunningJobsPrefix_';
    const waitingJobsPrefix = 'mockWaitingJobsPrefix_';
    let redisServer;
    let redis;
    let mockRedisConfig;
    let helperMock;
    let timeout;
    let LuaScriptLoader;
    let luaScriptLoader;

    before(async () => {
        // Start Redis server
        redisServer = await RedisMemoryServer.create();
        const host = await redisServer.getHost();
        const port = await redisServer.getPort();

        redis = new Redis({
            host,
            port,
            lazyConnect: true
        });

        await redis.connect();

        // Setup mockery for config and helper
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });

        mockRedisConfig = {
            queuePrefix,
            runningJobsPrefix,
            waitingJobsPrefix
        };

        helperMock = {
            updateBuildStatus: sinon.stub().resolves(),
            updateStepStop: sinon.stub().resolves(),
            getCurrentStep: sinon.stub().resolves({
                buildId: 222,
                name: 'wait'
            })
        };

        mockery.registerMock('../../../config/redis', mockRedisConfig);
        mockery.registerMock('../../helper', helperMock);

        // Load LuaScriptLoader and initialize it with our test Redis
        // eslint-disable-next-line global-require
        LuaScriptLoader = require('../../../../plugins/worker/lib/LuaScriptLoader');
        luaScriptLoader = new LuaScriptLoader(redis);
        // Pre-load the checkTimeout.lua script
        await luaScriptLoader.loadScript('checkTimeout.lua');

        // Mock the worker module to provide luaScriptLoader
        mockery.registerMock('../worker', {
            luaScriptLoader
        });

        // eslint-disable-next-line global-require
        timeout = require('../../../../plugins/worker/lib/timeout');
    });

    beforeEach(async () => {
        // Clear Redis before each test
        await redis.flushall();

        // Reset stubs
        helperMock.updateBuildStatus.resetHistory();
        helperMock.updateStepStop.resetHistory();
        helperMock.getCurrentStep.resetHistory();
        helperMock.getCurrentStep.resolves({
            buildId: 222,
            name: 'wait'
        });
    });

    after(async () => {
        mockery.deregisterAll();
        mockery.disable();

        if (redis) {
            await redis.quit();
        }
        if (redisServer) {
            await redisServer.stop();
        }
    });

    describe('check', () => {
        beforeEach(async () => {
            // Setup timeout configs for multiple builds
            await redis.hset(
                `${queuePrefix}timeoutConfigs`,
                '222',
                JSON.stringify({
                    jobId: 2,
                    timeout: 50
                })
            );
            await redis.hset(
                `${queuePrefix}timeoutConfigs`,
                '333',
                JSON.stringify({
                    jobId: 2,
                    startTime: Date.now(),
                    timeout: 50
                })
            );
            await redis.hset(
                `${queuePrefix}timeoutConfigs`,
                '444',
                JSON.stringify({
                    jobId: 3,
                    startTime: Date.now(),
                    timeout: 90
                })
            );
        });

        it('Updates build status to FAILURE if time difference is greater than timeout', async () => {
            const now = new Date();

            now.setHours(now.getHours() - 1); // 60 minutes ago

            const buildId = '333';
            const buildConfig = {
                jobId: 2,
                jobName: 'deploy',
                annotations: {
                    'screwdriver.cd/timeout': 50
                },
                apiUri: 'fake',
                buildId,
                eventId: 75
            };

            const timeoutConfig = {
                jobId: 2,
                startTime: now.getTime(),
                timeout: 50
            };

            // Setup Redis state
            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));
            await redis.hset(`${queuePrefix}buildConfigs`, buildId, JSON.stringify(buildConfig));
            await redis.set(`${runningJobsPrefix}${buildConfig.jobId}`, buildId);

            await timeout.checkWithBackOff(redis, 1, 0);

            // Verify updateBuildStatus was called
            assert.calledOnce(helperMock.updateBuildStatus);
            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: redis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout (51 minutes)',
                buildConfig // buildConfig is now passed to avoid Redis lookup
            });

            // Verify Redis state was cleaned up by Lua script
            const buildConfigExists = await redis.hexists(`${queuePrefix}buildConfigs`, buildId);
            const timeoutConfigExists = await redis.hexists(`${queuePrefix}timeoutConfigs`, buildId);

            assert.strictEqual(buildConfigExists, 0, 'buildConfig should be deleted');
            assert.strictEqual(timeoutConfigExists, 0, 'timeoutConfig should be deleted');

            // Verify running key was expired
            const runningTtl = await redis.ttl(`${runningJobsPrefix}${buildConfig.jobId}`);

            assert.isTrue(runningTtl <= 0, 'running key should be expired');
        });

        it('Updates step with exit code if time difference is greater than timeout', async () => {
            const now = new Date();

            now.setHours(now.getHours() - 1);

            const buildId = '333';
            const buildConfig = {
                jobId: 2,
                jobName: 'deploy',
                annotations: {
                    'screwdriver.cd/timeout': 50
                },
                apiUri: 'fake',
                buildId,
                eventId: 75
            };
            const timeoutConfig = {
                jobId: 2,
                startTime: now.getTime(),
                timeout: 50
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));
            await redis.hset(`${queuePrefix}buildConfigs`, buildId, JSON.stringify(buildConfig));
            await redis.set(`${runningJobsPrefix}${buildConfig.jobId}`, buildId);

            await timeout.checkWithBackOff(redis, 1, 0);

            // Verify updateStepStop was called
            assert.calledOnce(helperMock.updateStepStop);
            assert.calledWith(helperMock.updateStepStop, {
                redisInstance: redis,
                buildId,
                stepName: 'wait',
                code: 3,
                buildConfig // buildConfig is now passed to avoid Redis lookup
            });
        });

        it('Updatebuildstatus not called if time difference still less than timeout', async () => {
            const now = new Date();

            now.setMinutes(now.getMinutes() - 20); // Only 20 minutes ago (timeout is 50)

            const buildId = '333';
            const timeoutConfig = {
                jobId: 2,
                startTime: now.getTime(),
                timeout: 50
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));
            await redis.hset(`${queuePrefix}buildConfigs`, buildId, JSON.stringify({ jobId: 2 }));
            await redis.set(`${runningJobsPrefix}2`, buildId);

            await timeout.checkWithBackOff(redis, 1, 0);

            // Build should not time out
            assert.notCalled(helperMock.getCurrentStep);
            assert.notCalled(helperMock.updateStepStop);
            assert.notCalled(helperMock.updateBuildStatus);

            // Build config should still exist
            const buildConfigExists = await redis.hexists(`${queuePrefix}buildConfigs`, buildId);

            assert.strictEqual(buildConfigExists, 1, 'buildConfig should still exist');
        });

        it('Takes default timeout if value is NaN', async () => {
            const now = new Date();

            now.setMinutes(now.getMinutes() - 92); // 92 minutes ago (default is 90 + 1 buffer = 91)

            const buildId = '333';
            const buildConfig = {
                jobId: 2,
                jobName: 'deploy',
                buildId
            };
            const timeoutConfig = {
                jobId: 2,
                startTime: now.getTime(),
                timeout: null
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));
            await redis.hset(`${queuePrefix}buildConfigs`, buildId, JSON.stringify(buildConfig));
            await redis.set(`${runningJobsPrefix}${buildConfig.jobId}`, buildId);

            await timeout.checkWithBackOff(redis, 1, 0);

            // Should use default timeout (90 minutes)
            assert.calledOnce(helperMock.updateBuildStatus);
            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: redis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout (91 minutes)',
                buildConfig // buildConfig is now passed to avoid Redis lookup
            });

            // Verify cleanup
            const timeoutConfigExists = await redis.hexists(`${queuePrefix}timeoutConfigs`, buildId);

            assert.strictEqual(timeoutConfigExists, 0, 'timeoutConfig should be deleted');
        });

        it('No op if start time is not set in timeout config', async () => {
            const buildId = '222';
            const timeoutConfig = {
                jobId: 2,
                timeout: 50
                // No startTime
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));

            await timeout.checkWithBackOff(redis, 1, 0);

            // Should not process timeout without startTime
            assert.notCalled(helperMock.getCurrentStep);
            assert.notCalled(helperMock.updateStepStop);
            assert.notCalled(helperMock.updateBuildStatus);

            // Timeout config should be cleaned up
            const timeoutConfigExists = await redis.hexists(`${queuePrefix}timeoutConfigs`, buildId);

            assert.strictEqual(timeoutConfigExists, 0, 'timeoutConfig should be deleted');
        });

        it('Updatebuildstatus is called even if there are no active steps', async () => {
            const now = new Date();

            now.setHours(now.getHours() - 1);

            const buildId = '333';
            const buildConfig = {
                jobId: 2,
                jobName: 'deploy',
                buildId
            };
            const timeoutConfig = {
                jobId: 2,
                startTime: now.getTime(),
                timeout: 50
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));
            await redis.hset(`${queuePrefix}buildConfigs`, buildId, JSON.stringify(buildConfig));
            await redis.set(`${runningJobsPrefix}${buildConfig.jobId}`, buildId);
            helperMock.getCurrentStep.resolves(null); // No active step

            await timeout.checkWithBackOff(redis, 1, 0);

            // updateStepStop should not be called (no active step)
            assert.notCalled(helperMock.updateStepStop);

            // But updateBuildStatus should still be called
            assert.calledOnce(helperMock.updateBuildStatus);
            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: redis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout (51 minutes)',
                buildConfig // buildConfig is now passed to avoid Redis lookup
            });
        });

        it('Skip execution if polling interval is not reached', async () => {
            const buildId = '222';
            const timeoutConfig = {
                jobId: 2,
                timeout: 50
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));

            // pollCount = 5 should skip (not divisible by 6)
            await timeout.checkWithBackOff(redis, 1, 5);

            // Should not process anything
            assert.notCalled(helperMock.getCurrentStep);
            assert.notCalled(helperMock.updateStepStop);
            assert.notCalled(helperMock.updateBuildStatus);
        });

        it('Run timeoutcheck correctly when called with multiple workers', async () => {
            const now = new Date();
            const workerId1 = 1;
            const workerId2 = 2;

            now.setHours(now.getHours() - 1);

            const buildId = '333';
            const buildConfig = {
                jobId: 2,
                jobName: 'deploy',
                annotations: {
                    'screwdriver.cd/timeout': 50
                },
                apiUri: 'fake',
                buildId,
                eventId: 75
            };

            const timeoutConfig = {
                jobId: 2,
                startTime: now.getTime(),
                timeout: 50
            };

            await redis.hset(`${queuePrefix}timeoutConfigs`, buildId, JSON.stringify(timeoutConfig));
            await redis.hset(`${queuePrefix}buildConfigs`, buildId, JSON.stringify(buildConfig));
            await redis.set(`${runningJobsPrefix}${buildConfig.jobId}`, buildId);

            // Worker 1 with pollCount 10 - should skip
            await timeout.checkWithBackOff(redis, workerId1, 10);

            assert.notCalled(helperMock.getCurrentStep);
            assert.notCalled(helperMock.updateStepStop);
            assert.notCalled(helperMock.updateBuildStatus);

            // Worker 2 with pollCount 0 - should process
            await timeout.checkWithBackOff(redis, workerId2, 0);

            assert.calledOnce(helperMock.updateBuildStatus);
            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: redis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout (51 minutes)',
                buildConfig // buildConfig is now passed to avoid Redis lookup
            });

            // Verify cleanup
            const timeoutConfigExists = await redis.hexists(`${queuePrefix}timeoutConfigs`, buildId);

            assert.strictEqual(timeoutConfigExists, 0, 'timeoutConfig should be deleted');
        });
    });
});
