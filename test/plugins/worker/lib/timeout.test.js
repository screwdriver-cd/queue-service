'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

let deleteKey;
let expireKey;
let waitingKey;

describe('Timeout test', () => {
    const queuePrefix = 'mockQueuePrefix_';
    const runningJobsPrefix = undefined;
    const waitingJobsPrefix = undefined;
    let mockRedis;
    let mockRedisConfig;
    let helperMock;
    let timeout;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockRedis = {
            hget: sinon.stub().resolves(),
            hdel: sinon.stub().resolves(null),
            get: sinon.stub().resolves(null),
            expire: sinon.stub().resolves(),
            del: sinon.stub().resolves(),
            lrem: sinon.stub().resolves(),
            hkeys: sinon.stub().resolves()
        };

        mockRedisConfig = {
            queuePrefix: 'mockQueuePrefix_'
        };
        helperMock = {
            updateBuildStatus: sinon.stub(),
            updateStepStop: sinon.stub(),
            getCurrentStep: sinon.stub().resolves({
                buildId: 222,
                name: 'wait'
            })
        };

        mockery.registerMock('../../../config/redis', mockRedisConfig);
        mockery.registerMock('../../helper.js', helperMock);

        // eslint-disable-next-line global-require
        timeout = require('../../../../plugins/worker/lib/timeout.js');
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        process.removeAllListeners('SIGTERM');
    });

    after(() => {
        mockery.disable();
    });

    describe('check', () => {
        beforeEach(() => {
            expireKey = `${runningJobsPrefix}2`;
            waitingKey = `${waitingJobsPrefix}2`;

            mockRedis.hkeys.withArgs(`${queuePrefix}timeoutConfigs`).resolves(['222', '333', '444']);
        });

        it('Updates build status to FAILURE if time difference is greater than timeout', async () => {
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
                startTime: now,
                timeout: 50
            };

            deleteKey = `deleted_${buildConfig.jobId}_${buildId}`;

            mockRedis.hget.withArgs(`${queuePrefix}timeoutConfigs`, buildId).resolves(JSON.stringify(timeoutConfig));

            await timeout.check(mockRedis);

            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: mockRedis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout'
            });
            assert.calledWith(mockRedis.hdel, `${queuePrefix}buildConfigs`, buildId);
            assert.calledWith(mockRedis.expire, expireKey, 0);
            assert.calledWith(mockRedis.expire, expireKey, 0);

            assert.calledWith(mockRedis.del, deleteKey);
            assert.calledWith(mockRedis.lrem, waitingKey, 0, buildId);
            assert.calledWith(mockRedis.hdel, `${queuePrefix}timeoutConfigs`, buildId);
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
                startTime: now,
                timeout: 50
            };

            deleteKey = `deleted_${buildConfig.jobId}_${buildId}`;

            mockRedis.hget.withArgs(`${queuePrefix}timeoutConfigs`, buildId).resolves(JSON.stringify(timeoutConfig));

            await timeout.check(mockRedis);

            assert.calledWith(helperMock.updateStepStop, {
                redisInstance: mockRedis,
                buildId,
                stepName: 'wait',
                code: 3
            });
        });

        it('Updatebuildstatus not called if time difference still less than timeout', async () => {
            const now = new Date();

            now.setMinutes(now.getMinutes() - 20);

            const buildId = '333';
            const timeoutConfig = {
                jobId: 2,
                startTime: now,
                timeout: 50
            };

            mockRedis.hget.withArgs(`${queuePrefix}timeoutConfigs`, buildId).resolves(JSON.stringify(timeoutConfig));

            await timeout.check(mockRedis);

            assert.notCalled(helperMock.getCurrentStep);
            assert.notCalled(helperMock.updateStepStop);
            assert.notCalled(helperMock.updateBuildStatus);
            assert.notCalled(mockRedis.expire);
            assert.notCalled(mockRedis.del);
            assert.notCalled(mockRedis.lrem);
        });

        it('Takes default timeout if value is NaN', async () => {
            const now = new Date();

            now.setMinutes(now.getMinutes() - 92);

            const buildId = '333';
            const timeoutConfig = {
                jobId: 2,
                startTime: now,
                timeout: null
            };

            deleteKey = `deleted_${timeoutConfig.jobId}_${buildId}`;

            mockRedis.hget.withArgs(`${queuePrefix}timeoutConfigs`, buildId).resolves(JSON.stringify(timeoutConfig));

            await timeout.check(mockRedis);

            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: mockRedis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout'
            });
            assert.calledWith(mockRedis.hdel, `${queuePrefix}buildConfigs`, buildId);
            assert.calledWith(mockRedis.expire, expireKey, 0);
            assert.calledWith(mockRedis.expire, expireKey, 0);

            assert.calledWith(mockRedis.del, deleteKey);
            assert.calledWith(mockRedis.lrem, waitingKey, 0, buildId);
            assert.calledWith(mockRedis.hdel, `${queuePrefix}timeoutConfigs`, buildId);
        });

        it('No op if start time is not set in timeout config', async () => {
            const buildId = '222';
            const timeoutConfig = {
                jobId: 2,
                timeout: 50
            };

            mockRedis.hget.withArgs(`${queuePrefix}timeoutConfigs`, buildId).resolves(JSON.stringify(timeoutConfig));

            await timeout.check(mockRedis);

            assert.notCalled(helperMock.getCurrentStep);
            assert.notCalled(helperMock.updateStepStop);
            assert.notCalled(helperMock.updateBuildStatus);
            assert.notCalled(mockRedis.expire);
            assert.notCalled(mockRedis.del);
            assert.notCalled(mockRedis.lrem);
        });

        it('Updatebuildstatus is called even if there are no active steps', async () => {
            const now = new Date();

            now.setHours(now.getHours() - 1);

            const buildId = '333';
            const timeoutConfig = {
                jobId: 2,
                startTime: now,
                timeout: 50
            };

            mockRedis.hget.withArgs(`${queuePrefix}timeoutConfigs`, buildId).resolves(JSON.stringify(timeoutConfig));
            helperMock.getCurrentStep.resolves(null);

            await timeout.check(mockRedis);

            assert.notCalled(helperMock.updateStepStop);
            assert.calledWith(helperMock.updateBuildStatus, {
                redisInstance: mockRedis,
                buildId,
                status: 'FAILURE',
                statusMessage: 'Build failed due to timeout'
            });
            assert.calledWith(mockRedis.hdel, `${queuePrefix}buildConfigs`, buildId);
            assert.calledWith(mockRedis.expire, expireKey, 0);
            assert.calledWith(mockRedis.expire, expireKey, 0);

            assert.calledWith(mockRedis.del, deleteKey);
            assert.calledWith(mockRedis.lrem, waitingKey, 0, buildId);
            assert.calledWith(mockRedis.hdel, `${queuePrefix}timeoutConfigs`, buildId);
        });
    });
});
