'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Helper Test', () => {
    const job = { args: [{ buildId: 1 }] };
    const status = 'BLOCKED';
    const statusMessage = 'blocked by these bloking jobs: 123, 456';
    const requestOptions = {
        headers: {
            Authorization: 'Bearer fake',
            'Content-Type': 'application/json'
        },
        json: true,
        method: 'PUT',
        body: {
            status,
            statusMessage
        },
        uri: `foo.bar/v4/builds/${job.args[0].buildId}`
    };
    let mockRequest;
    let mockRequestRetry;
    let mockRedis;
    let mockRedisConfig;
    let helper;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockRequest = sinon.stub();
        mockRequestRetry = sinon.stub();
        mockRedis = {
            hget: sinon.stub().resolves('{"apiUri": "foo.bar", "token": "fake"}')
        };

        mockRedisConfig = {
            queuePrefix: 'mockQueuePrefix_'
        };

        mockery.registerMock('request', mockRequest);
        mockery.registerMock('requestretry', mockRequestRetry);
        mockery.registerMock('../config/redis', mockRedisConfig);

        // eslint-disable-next-line global-require
        helper = require('../../plugins/helper.js');
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        process.removeAllListeners('SIGTERM');
    });

    after(() => {
        mockery.disable();
    });

    it('logs correct message when successfully update build failure status', async () => {
        mockRequest.yieldsAsync(null, { statusCode: 200 });
        try {
            await helper.updateBuildStatus({
                redisInstance: mockRedis,
                status,
                statusMessage,
                buildId: 1
            });
        } catch (err) {
            assert.isNull(err);
        }
        assert.calledWith(mockRedis.hget, 'mockQueuePrefix_buildConfigs', job.args[0].buildId);
        assert.calledWith(mockRequest, requestOptions);
    });

    it('logs correct message when fail to update build failure status', async () => {
        const requestErr = new Error('failed to update');
        const response = {};

        mockRequest.yieldsAsync(requestErr, response);

        try {
            await helper.updateBuildStatus({
                redisInstance: mockRedis,
                status,
                statusMessage,
                buildId: 1
            });
        } catch (err) {
            assert.calledWith(mockRequest, requestOptions);
            assert.strictEqual(err.message, 'failed to update');
        }
    });

    it('logs correct message when successfully update step with code', async () => {
        const stepName = 'wait';
        const dateNow = Date.now();
        const isoTime = new Date(dateNow).toISOString();
        const sandbox = sinon.createSandbox({
            useFakeTimers: false
        });

        sandbox.useFakeTimers(dateNow);
        mockRequest.yieldsAsync(null, { statusCode: 200 });

        const res = await helper.updateStepStop({
            redisInstance: mockRedis,
            buildId: 1,
            code: 3,
            stepName
        });

        assert.calledWith(mockRedis.hget, 'mockQueuePrefix_buildConfigs', job.args[0].buildId);
        assert.calledWith(mockRequest, {
            headers: {
                Authorization: 'Bearer fake',
                'Content-Type': 'application/json'
            },
            json: true,
            method: 'PUT',
            uri: `foo.bar/v4/builds/${job.args[0].buildId}/steps/${stepName}`,
            body: {
                endTime: isoTime,
                code: 3
            }
        });
        assert.isUndefined(res);
        sandbox.restore();
    });

    it('logs correct message when fail to update step with code', async () => {
        const stepName = 'wait';
        const requestErr = new Error('failed to update');
        const response = [];
        const dateNow = Date.now();
        const isoTime = new Date(dateNow).toISOString();
        const sandbox = sinon.createSandbox({
            useFakeTimers: false
        });

        sandbox.useFakeTimers(dateNow);
        mockRequest.yieldsAsync(requestErr, response);

        try {
            await helper.updateStepStop({
                redisInstance: mockRedis,
                buildId: 1,
                code: 3,
                stepName
            });
        } catch (err) {
            assert.strictEqual(err.message, requestErr.message);
        }

        assert.calledWith(mockRequest, {
            headers: {
                Authorization: 'Bearer fake',
                'Content-Type': 'application/json'
            },
            json: true,
            method: 'PUT',
            uri: `foo.bar/v4/builds/${job.args[0].buildId}/steps/${stepName}`,
            body: {
                endTime: isoTime,
                code: 3
            }
        });
        sandbox.restore();
    });

    it('returns correct when get current step is called', async () => {
        mockRequest.yieldsAsync(null, {
            statusCode: 200,
            body: [{ stepName: 'wait' }]
        });

        const res = await helper.getCurrentStep({
            redisInstance: mockRedis,
            buildId: 1
        });

        assert.calledWith(mockRedis.hget, 'mockQueuePrefix_buildConfigs', job.args[0].buildId);
        assert.calledWith(mockRequest, {
            headers: {
                Authorization: 'Bearer fake',
                'Content-Type': 'application/json'
            },
            json: true,
            method: 'GET',
            uri: `foo.bar/v4/builds/${job.args[0].buildId}/steps?status=active`
        });
        assert.equal(res.stepName, 'wait');
    });

    it('Correctly creates build event', async () => {
        mockRequestRetry.yieldsAsync(null, { statusCode: 201 });
        const retryFn = sinon.stub();

        try {
            await helper.createBuildEvent('foo.bar', 'fake', { buildId: 1, eventId: 321, jobId: 123 }, retryFn);
        } catch (err) {
            assert.isNull(err);
        }

        assert.calledWith(mockRequestRetry, {
            json: true,
            method: 'POST',
            uri: 'foo.bar/v4/events',
            headers: {
                Authorization: 'Bearer fake',
                'Content-Type': 'application/json'
            },
            body: { buildId: 1, eventId: 321, jobId: 123 },
            maxAttempts: 3,
            retryDelay: 5000,
            retryStrategy: retryFn
        });
    });

    it('Gets the pipeline admin correctly', async () => {
        mockRequestRetry.yieldsAsync(null, {
            statusCode: 200,
            body: { username: 'admin123' }
        });
        const retryFn = sinon.stub();
        const pipelineId = 123456;
        let result;

        try {
            result = await helper.getPipelineAdmin('fake', 'foo.bar', pipelineId, retryFn);
        } catch (err) {
            assert.isNull(err);
        }

        assert.calledWith(mockRequestRetry, {
            json: true,
            method: 'GET',
            uri: `foo.bar/v4/pipelines/${pipelineId}/admin`,
            headers: {
                Authorization: 'Bearer fake',
                'Content-Type': 'application/json'
            },
            maxAttempts: 3,
            retryDelay: 5000,
            retryStrategy: retryFn
        });
        assert.equal(result.username, 'admin123');
    });

    it('Updates build status with retry', async () => {
        mockRequestRetry.yieldsAsync(null, { statusCode: 200 });
        const retryFn = sinon.stub();
        const buildId = 1;

        try {
            await helper.updateBuild(
                {
                    apiUri: 'foo.bar',
                    token: 'fake',
                    buildId,
                    payload: {
                        status,
                        statusMessage
                    }
                },
                retryFn
            );
        } catch (err) {
            assert.isNull(err);
        }

        assert.calledWith(mockRequestRetry, {
            json: true,
            method: 'PUT',
            uri: `foo.bar/v4/builds/${buildId}`,
            headers: {
                Authorization: 'Bearer fake',
                'Content-Type': 'application/json'
            },
            body: { status, statusMessage },
            maxAttempts: 3,
            retryDelay: 5000,
            retryStrategy: retryFn
        });
    });
});
