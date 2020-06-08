'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('CacheFilter Plugin Test', () => {
    const mockJob = {};
    const mockFunc = () => {};
    const mockQueue = 'queuename';
    let mockWorker;
    let mockArgs;
    let mockRedis;
    let CacheFilter;
    let filter;
    let buildConfig;
    let mockRabbitmqConfigObj;
    let mockRabbitmqConfig;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockArgs = [
            {
                id: 123,
                resource: 'caches',
                scope: 'pipelines',
                action: 'delete',
                prefix: '',
                buildClusters: ['sd1', 'sd2']
            }
        ];

        buildConfig = {
            buildClusterName: 'sd1'
        };

        mockRedis = {
            hget: sinon.stub().resolves(JSON.stringify(buildConfig))
        };

        mockWorker = {
            queueObject: {
                connection: {
                    redis: mockRedis
                },
                enqueueIn: sinon.stub().resolves()
            }
        };

        mockRabbitmqConfigObj = {
            schedulerMode: false,
            amqpURI: 'amqp://localhost:5672',
            exchange: 'build'
        };

        mockRabbitmqConfig = {
            getConfig: sinon.stub().returns(mockRabbitmqConfigObj)
        };

        mockery.registerMock('../../../config/rabbitmq', mockRabbitmqConfig);
        mockery.registerMock('ioredis', mockRedis);

        // eslint-disable-next-line global-require
        CacheFilter = require('../../../../plugins/worker/lib/CacheFilter.js').CacheFilter;

        filter = new CacheFilter(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {});
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('Filter', () => {
        it('constructor', async () => {
            assert.equal(filter.name, 'CacheFilter');
        });

        describe('beforePerform', () => {
            it('proceeds if config has resource as caches', async () => {
                const proceed = await filter.beforePerform();

                assert.isTrue(proceed);
            });

            it("doesn't proceed if build has no id or resource", async () => {
                mockArgs = [
                    {
                        id: 123,
                        resource: null,
                        scope: 'pipelines',
                        action: 'delete',
                        prefix: ''
                    }
                ];
                filter = new CacheFilter(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {});

                const proceed = await filter.beforePerform();

                assert.isFalse(proceed);
            });
        });
    });
});
