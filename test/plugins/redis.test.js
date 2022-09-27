'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const hoek = require('@hapi/hoek');

sinon.assert.expose(assert, { prefix: '' });

describe('redis plugin', () => {
    const connectionDetails = {
        redisOptions: { password: 'dummy' }
    };
    const ioredisMock = sinon.stub();

    ioredisMock.Cluster = sinon.stub();

    before(() => {
        mockery.enable({
            warnOnUnregistered: false,
            useCleanCache: true
        });
    });

    beforeEach(() => {
        mockery.registerMock('ioredis', ioredisMock);
        mockery.registerMock('../config/redis', { connectionDetails });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    it('returns Redis instance', async () => {
        ioredisMock.prototype.on = sinon.stub();

        /* eslint-disable global-require */
        require('../../plugins/redis');

        assert.calledWith(ioredisMock, { password: 'dummy' });
    });

    it('returns Redis.Cluster instance', async () => {
        const clusterConnectionDetails = hoek.applyToDefaults(connectionDetails, {
            redisClusterHosts: ['127.0.0.0:4321', '127.0.0.0:4322', '127.0.0.0:4323'],
            slotsRefreshTimeout: 100
        });

        ioredisMock.Cluster.prototype.on = sinon.stub();
        mockery.registerMock('../config/redis', { connectionDetails: clusterConnectionDetails });
        /* eslint-disable global-require */
        require('../../plugins/redis');

        assert.calledWith(ioredisMock.Cluster, ['127.0.0.0:4321', '127.0.0.0:4322', '127.0.0.0:4323'], {
            redisOptions: { password: 'dummy' },
            slotsRefreshTimeout: 100
        });
    });
});
