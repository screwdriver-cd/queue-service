'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const hoek = require('@hapi/hoek');

sinon.assert.expose(assert, { prefix: '' });

describe('redis config', () => {
    const queueConfig = {
        connectionType: 'redis',
        redisConnection: {
            port: 4321,
            host: '127.0.0.0',
            options: {
                tls: true,
                password: 'abcd'
            },
            database: 0
        },
        redisClusterConnection: {
            hosts: ['127.0.0.0:4321', '127.0.0.0:4322', '127.0.0.0:4323'],
            options: {
                tls: true,
                password: 'abcd'
            },
            slotsRefreshTimeout: 1000
        },
        prefix: 'test'
    };
    const configMock = {
        get: sinon.stub()
    };

    before(() => {
        mockery.enable({
            warnOnUnregistered: false,
            useCleanCache: true
        });
    });

    beforeEach(() => {
        mockery.registerMock('config', configMock);
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    it('gets config for a redis connection', async () => {
        configMock.get.returns(hoek.applyToDefaults(queueConfig, {}));

        /* eslint-disable global-require */
        const redisConfig = require('../../config/redis');

        assert.deepEqual(redisConfig.connectionDetails.redisOptions, {
            port: 4321,
            host: '127.0.0.0',
            tls: true,
            password: 'abcd',
            database: 0
        });
        assert.equal(redisConfig.queueNamespace, 'resque');
        assert.equal(redisConfig.queuePrefix, 'test');
        assert.equal(redisConfig.runningJobsPrefix, 'testrunning_job_');
        assert.equal(redisConfig.waitingJobsPrefix, 'testwaiting_job_');
    });

    it('gets config for redisCluster connection', async () => {
        configMock.get.returns(hoek.applyToDefaults(queueConfig, { connectionType: 'redisCluster' }));

        /* eslint-disable global-require */
        const redisConfig = require('../../config/redis');

        assert.deepEqual(redisConfig.connectionDetails.redisOptions, {
            tls: true,
            password: 'abcd'
        });
        assert.equal(redisConfig.connectionDetails.redisClusterHosts[0], '127.0.0.0:4321');
        assert.equal(redisConfig.connectionDetails.redisClusterHosts[1], '127.0.0.0:4322');
        assert.equal(redisConfig.connectionDetails.redisClusterHosts[2], '127.0.0.0:4323');
        assert.equal(redisConfig.queueNamespace, 'resque:{screwdriver-resque}');
        assert.equal(redisConfig.queuePrefix, 'test');
        assert.equal(redisConfig.runningJobsPrefix, 'testrunning_job_');
        assert.equal(redisConfig.waitingJobsPrefix, 'testwaiting_job_');
    });

    it('throws exception if unkown connectionType is specified', async () => {
        configMock.get.returns(hoek.applyToDefaults(queueConfig, { connectionType: 'mysql' }));

        try {
            /* eslint-disable global-require */
            require('../../config/redis');
        } catch (err) {
            assert.exists(err, "'redis' or 'redisCluster' can be set for queue.connectionType");
        }
    });
});
