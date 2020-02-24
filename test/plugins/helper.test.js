'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Helper Test', () => {
    const job = { args: [{ buildId: 1 }] };
    const status = 'BLOCKED';
    const statusMessage = 'blocked by these bloking jobs: 123, 456';
    const requestOptions = {
        auth: { bearer: 'fake' },
        json: true,
        method: 'PUT',
        body: {
            status,
            statusMessage
        },
        uri: `foo.bar/v4/builds/${job.args[0].buildId}`
    };
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
        mockRequest = sinon.stub();
        mockRedis = { hget: sinon.stub().resolves('{"apiUri": "foo.bar", "token": "fake"}') };

        mockRedisConfig = {
            queuePrefix: 'mockQueuePrefix_'
        };

        mockery.registerMock('request', mockRequest);
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

    it('logs correct message when successfully update build failure status', (done) => {
        mockRequest.yieldsAsync(null, { statusCode: 200 });

        helper.updateBuildStatus({
            redisInstance: mockRedis,
            status,
            statusMessage,
            buildId: 1
        }, (err) => {
            assert.calledWith(mockRedis.hget,
                'mockQueuePrefix_buildConfigs', job.args[0].buildId);
            assert.calledWith(mockRequest, requestOptions);
            assert.isNull(err);
            done();
        });
    });

    it('logs correct message when fail to update build failure status', (done) => {
        const requestErr = new Error('failed to update');
        const response = {};

        mockRequest.yieldsAsync(requestErr, response);

        helper.updateBuildStatus({
            redisInstance: mockRedis,
            status,
            statusMessage,
            buildId: 1
        }, (err) => {
            assert.calledWith(mockRequest, requestOptions);
            assert.strictEqual(err.message, 'failed to update');
            done();
        });
    });

    it('logs correct message when successfully update step with code', async () => {
        const stepName = 'wait';
        const dateNow = Date.now();
        const isoTime = (new Date(dateNow)).toISOString();
        const sandbox = sinon.sandbox.create({
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

        assert.calledWith(mockRedis.hget,
            'mockQueuePrefix_buildConfigs', job.args[0].buildId);
        assert.calledWith(mockRequest, {
            auth: { bearer: 'fake' },
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
        const isoTime = (new Date(dateNow)).toISOString();
        const sandbox = sinon.sandbox.create({
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
            auth: { bearer: 'fake' },
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
        mockRequest.yieldsAsync(null, { statusCode: 200, body: [{ stepName: 'wait' }] });

        const res = await helper.getCurrentStep({
            redisInstance: mockRedis,
            buildId: 1
        });

        assert.calledWith(mockRedis.hget,
            'mockQueuePrefix_buildConfigs', job.args[0].buildId);
        assert.calledWith(mockRequest, {
            auth: { bearer: 'fake' },
            json: true,
            method: 'GET',
            uri: `foo.bar/v4/builds/${job.args[0].buildId}/steps?status=active`
        });
        assert.equal(res.stepName, 'wait');
    });
});
