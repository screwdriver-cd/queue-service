'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Plugin Test', () => {
    const jobId = 777;
    const buildId = 3;
    const mockJob = {};
    const mockFunc = () => {};
    const mockQueue = 'queuename';
    let mockWorker;
    let mockArgs;
    let mockRedis;
    let Filter;
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
        mockArgs = [{
            jobId,
            buildId,
            blockedBy: '111,222,777'
        }];

        buildConfig = {
            apiUri: 'foo.bar',
            token: 'fake'
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
            exchange: 'build',
            exchangeType: 'topic'
        };

        mockRabbitmqConfig = {
            getConfig: sinon.stub().returns(mockRabbitmqConfigObj)
        };

        mockery.registerMock('../../../config/rabbitmq', mockRabbitmqConfig);
        mockery.registerMock('ioredis', mockRedis);

        // eslint-disable-next-line global-require
        Filter = require('../../../../plugins/worker/lib/Filter.js').Filter;

        filter = new Filter(mockWorker, mockFunc, mockQueue, mockJob, mockArgs, {});
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
            assert.equal(filter.name, 'Filter');
        });

        describe('beforePerform', () => {
            it('proceeds if build without buildClusterName landed on worker', async () => {
                const proceed = await filter.beforePerform();

                assert.isTrue(proceed);
            });

            it('doesn\'t proceed if build without buildConfig landed on worker', async () => {
                mockRedis.hget.resolves(JSON.stringify(null));

                const proceed = await filter.beforePerform();

                assert.isFalse(proceed);
            });

            it('re-enqueue if build with buildClusterName landed on worker', async () => {
                buildConfig.buildClusterName = 'sd';
                mockRedis.hget.resolves(JSON.stringify(buildConfig));

                await filter.beforePerform();

                assert.calledWith(mockWorker.queueObject.enqueueIn,
                    1000, mockQueue, mockFunc, mockArgs);
            });

            it('proceeds if build with buildClusterName landed on scheduler', async () => {
                mockRabbitmqConfigObj.schedulerMode = true;
                mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
                buildConfig.buildClusterName = 'sd';
                mockRedis.hget.resolves(JSON.stringify(buildConfig));

                const proceed = await filter.beforePerform();

                assert.isTrue(proceed);
            });

            it('doesn\'t proceed if build without buildConfig landed on scheduler', async () => {
                mockRabbitmqConfigObj.schedulerMode = true;
                mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
                mockRedis.hget.resolves(JSON.stringify(null));

                const proceed = await filter.beforePerform();

                assert.isFalse(proceed);
            });

            it('re-enqueue if build without buildCluster landed on scheduler', async () => {
                mockRabbitmqConfigObj.schedulerMode = true;
                mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);

                await filter.beforePerform();

                assert.calledWith(mockWorker.queueObject.enqueueIn,
                    1000, mockQueue, mockFunc, mockArgs);
            });
        });
    });
});
