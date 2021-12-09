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
        mockRequest.resolves({ statusCode: 200 });
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
        mockRequest.resolves({ statusCode: 401, body: 'Unauthorized' });
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
        const requestErr = new Error('failed to update');

        mockRequest.rejects(requestErr);

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
        mockRequest.resolves({ statusCode: 200 });

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
            }
        });
        assert.isUndefined(res);
        sandbox.restore();
    });

    it('logs correct message when fail to update step with code', async () => {
        const stepName = 'wait';
        const requestErr = new Error('failed to update');
        const dateNow = Date.now();
        const isoTime = new Date(dateNow).toISOString();
        const sandbox = sinon.createSandbox({
            useFakeTimers: false
        });

        sandbox.useFakeTimers(dateNow);
        mockRequest.rejects(requestErr);

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
            }
        });
        sandbox.restore();
    });

    it('returns correct when get current step is called', async () => {
        mockRequest.resolves({
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
            url: `foo.bar/v4/builds/${job.args[0].buildId}/steps?status=active`
        });
        assert.equal(res.stepName, 'wait');
    });

    it('returns correct when get current step is called with empty body', async () => {
        mockRequest.resolves({
            statusCode: 200,
            body: []
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
            url: `foo.bar/v4/builds/${job.args[0].buildId}/steps?status=active`
        });
        assert.isNull(res);
    });

    it('Correctly creates build event', async () => {
        mockRequest.resolves({ statusCode: 201 });
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
                retry: {
                    limit: 3,
                    methods: ['POST']
                }
            })
        );
    });

    it('Correctly creates build event with response code 200', async () => {
        mockRequest.resolves({ statusCode: 200 });
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
                retry: {
                    limit: 3,
                    methods: ['POST']
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('throws when cannot creates build event correctly', async () => {
        mockRequest.resolves({
            statusCode: 403,
            body: { username: 'admin123' }
        });
        const retryFn = sinon.stub();

        try {
            await helper.createBuildEvent('foo.bar', 'fake', { buildId: 1, eventId: 321, jobId: 123 }, retryFn);
        } catch (err) {
            assert.strictEqual(err.message, '{"username":"admin123"}');
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
                retry: {
                    limit: 3,
                    methods: ['POST']
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('Gets the pipeline admin correctly', async () => {
        mockRequest.resolves({
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
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
        assert.equal(result.username, 'admin123');
    });

    it('throws when cannot get the pipeline admin correctly', async () => {
        mockRequest.resolves({
            statusCode: 403,
            body: { username: 'admin123' }
        });
        const retryFn = sinon.stub();
        const pipelineId = 123456;

        try {
            await helper.getPipelineAdmin('fake', 'foo.bar', pipelineId, retryFn);
        } catch (err) {
            assert.strictEqual(err.message, 'No pipeline admin found with 403 code and {"username":"admin123"}');
        }

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'GET',
                url: `foo.bar/v4/pipelines/${pipelineId}/admin`,
                headers: {
                    Authorization: 'Bearer fake'
                },
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('throws when get error fetching the pipeline admin', async () => {
        const requestErr = new Error('invalid');

        mockRequest.rejects(requestErr);

        const retryFn = sinon.stub();
        const pipelineId = 123456;

        try {
            await helper.getPipelineAdmin('fake', 'foo.bar', pipelineId, retryFn);
        } catch (err) {
            assert.strictEqual(err.message, requestErr.message);
        }

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'GET',
                url: `foo.bar/v4/pipelines/${pipelineId}/admin`,
                headers: {
                    Authorization: 'Bearer fake'
                },
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('Updates build status with retry', async () => {
        mockRequest.resolves({ statusCode: 200 });
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
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('throws when cannot update build status correctly', async () => {
        mockRequest.resolves({
            statusCode: 403,
            body: { username: 'admin123' }
        });
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
            assert.strictEqual(err.message, 'Build not updated with 403code and {"username":"admin123"}');
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
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('Post a webhooks process with retry', async () => {
        mockRequest.resolves({ statusCode: 200 });
        const retryFn = sinon.stub();

        try {
            await helper.processHooks('foo.bar', 'fake', { foo: 123 }, retryFn);
        } catch (err) {
            assert.isNull(err);
        }

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'POST',
                url: `foo.bar/v4/processHooks`,
                headers: {
                    Authorization: 'Bearer fake'
                },
                json: { foo: 123 },
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });

    it('throws when get error post a webhooks process', async () => {
        mockRequest.resolves({
            statusCode: 500,
            body: 'server error'
        });
        const retryFn = sinon.stub();

        try {
            await helper.processHooks('foo.bar', 'fake', { foo: 123 }, retryFn);
        } catch (err) {
            assert.strictEqual(err.message, 'Failed to process webhook with 500 code and server error');
        }

        assert.calledWith(
            mockRequest,
            sinon.match({
                method: 'POST',
                url: `foo.bar/v4/processHooks`,
                headers: {
                    Authorization: 'Bearer fake'
                },
                json: { foo: 123 },
                retry: {
                    limit: 3
                },
                hooks: { afterResponse: [retryFn] }
            })
        );
    });
});
