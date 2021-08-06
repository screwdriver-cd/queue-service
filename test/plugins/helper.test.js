'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Helper Test', () => {
    const job = { args: [{ buildId: 1 }] };
    const status = 'BLOCKED';
    const statusMessage = 'blocked by these bloking jobs: 123, 456';
    let requestOptions;
    let mockRequest;
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
        requestOptions = {
            headers: {
                Authorization: 'Bearer fake'
            },
            method: 'PUT',
            json: {
                status,
                statusMessage
            },
            url: `foo.bar/v4/builds/${job.args[0].buildId}`
        };
        mockRequest = sinon.stub();
        mockRedis = {
            hget: sinon.stub().resolves('{"apiUri": "foo.bar", "token": "fake"}')
        };

        mockRedisConfig = {
            queuePrefix: 'mockQueuePrefix_'
        };

        mockery.registerMock('screwdriver-request', mockRequest);
        mockery.registerMock('../config/redis', mockRedisConfig);

        // eslint-disable-next-line global-require
        helper = require('../../plugins/helper');
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
        requestOptions.context = { caller: 'updateBuildStatus' };
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

    it('logs correct message when fail to update build status with non 200 API response', async () => {
        requestOptions.context = { caller: 'updateBuildStatus' };
        mockRequest.yieldsAsync(null, { statusCode: 401, body: 'Unauthorized' });
        try {
            await helper.updateBuildStatus({
                redisInstance: mockRedis,
                status,
                statusMessage,
                buildId: 1
            });
        } catch (err) {
            assert.calledWith(mockRequest, requestOptions);
            assert.strictEqual(err.message, 'Failed to updateBuildStatus with 401 code and Unauthorized');
        }
    });

    it('logs correct message when fail to update build failure status', async () => {
        requestOptions.context = { caller: 'updateBuildStatus' };

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
                Authorization: 'Bearer fake'
            },
            method: 'PUT',
            url: `foo.bar/v4/builds/${job.args[0].buildId}/steps/${stepName}`,
            json: {
                endTime: isoTime,
                code: 3
            },
            context: { caller: 'updateStepStop' }
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
                Authorization: 'Bearer fake'
            },
            method: 'PUT',
            url: `foo.bar/v4/builds/${job.args[0].buildId}/steps/${stepName}`,
            json: {
                endTime: isoTime,
                code: 3
            },
            context: { caller: 'updateStepStop' }
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
                Authorization: 'Bearer fake'
            },
            method: 'GET',
            url: `foo.bar/v4/builds/${job.args[0].buildId}/steps?status=active`,
            context: { caller: 'getCurrentStep' }
        });
        assert.equal(res.stepName, 'wait');
    });

    it('Correctly creates build event', async () => {
        mockRequest.yieldsAsync(null, { statusCode: 201 });
        const retryFn = sinon.stub();

        try {
            await helper.createBuildEvent('foo.bar', 'fake', { buildId: 1, eventId: 321, jobId: 123 }, retryFn);
        } catch (err) {
            assert.isNull(err);
        }

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'POST',
                url: 'foo.bar/v4/events',
                headers: {
                    Authorization: 'Bearer fake'
                },
                json: { buildId: 1, eventId: 321, jobId: 123 },
                retryOptions: {
                    limit: 3,
                    methods: ['POST']
                },
                context: { caller: 'createBuildEvent' }
            })
        );
    });

    it('Correctly creates build event with response code 200', async () => {
        mockRequest.yieldsAsync(null, { statusCode: 200 });
        const retryFn = sinon.stub();

        try {
            await helper.createBuildEvent('foo.bar', 'fake', { buildId: 1, eventId: 321, jobId: 123 }, retryFn);
        } catch (err) {
            assert.isNull(err);
        }

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'POST',
                url: 'foo.bar/v4/events',
                headers: {
                    Authorization: 'Bearer fake'
                },
                json: { buildId: 1, eventId: 321, jobId: 123 },
                retryOptions: {
                    limit: 3,
                    methods: ['POST']
                },
                hooks: { afterResponse: [retryFn] },
                context: { caller: 'createBuildEvent' }
            })
        );
    });

    it('Gets the pipeline admin correctly', async () => {
        mockRequest.yieldsAsync(null, {
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

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'GET',
                url: `foo.bar/v4/pipelines/${pipelineId}/admin`,
                headers: {
                    Authorization: 'Bearer fake'
                },
                retryOptions: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] },
                context: { caller: 'getPipelineAdmin' }
            })
        );
        assert.equal(result.username, 'admin123');
    });

    it('Updates build status with retry', async () => {
        mockRequest.yieldsAsync(null, { statusCode: 200 });
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

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'PUT',
                url: `foo.bar/v4/builds/${buildId}`,
                headers: {
                    Authorization: 'Bearer fake'
                },
                json: { status, statusMessage },
                retryOptions: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] },
                context: { caller: 'updateBuild' }
            })
        );
    });
});
