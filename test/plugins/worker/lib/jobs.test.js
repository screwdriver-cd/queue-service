'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const testExecutorConfig = require('../../../data/executorConfig.json');

const fullConfig = {
    annotations: {
        'beta.screwdriver.cd/executor': 'k8s'
    },
    buildId: 8609,
    jobId: 777,
    jobName: 'main',
    blockedBy: [777],
    container: 'node:4',
    apiUri: 'http://api.com',
    token: 'asdf'
};
const partialConfig = {
    buildId: 8609,
    jobId: 777,
    jobName: 'main',
    blockedBy: [777]
};
const providerConfig = {
    accountId: '123',
    securityGroupId: 'sg-123',
    subnetId: ['subnet-123', 'subnet-321'],
    region: 'us-east-1',
    launcherImage: 'sdLauncher:v6',
    launcherVersion: 'v6',
    executor: 'sls'
};
const configWithProvider = { ...fullConfig, provider: providerConfig };

sinon.assert.expose(assert, { prefix: '' });

describe('Jobs Unit Test', () => {
    let jobs;
    let mockExecutor;
    let mockExecutorRouter;
    let mockRedis;
    let mockRedisObj;
    let mockBlockedBy;
    let mockFilter;
    let mockCacheFilter;
    let mockRabbitmqConfig;
    let mockRabbitmqConfigObj;
    let mockAmqp;
    let mockRabbitmqConnection;
    let mockRabbitmqCh;
    let mockRedisConfig;
    let mockKafkaConfig;
    let mockKafkaConfigObj;
    let mockConfig;
    let mockProducerSvc;
    let mockEcosystemConfig;
    let helperMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        mockExecutor = {
            start: sinon.stub(),
            stop: sinon.stub(),
            tokenGen: sinon.stub()
        };

        mockRedisObj = {
            hget: sinon.stub(),
            hdel: sinon.stub(),
            del: sinon.stub(),
            get: sinon.stub(),
            lrem: sinon.stub()
        };

        mockRabbitmqCh = {
            publish: sinon.stub().resolves(null),
            assertExchange: sinon.stub().resolves(null),
            close: sinon.stub().resolves(null),
            on: sinon.stub()
        };

        mockRabbitmqConnection = {
            on: sinon.stub(),
            createChannel: sinon.stub().returns(mockRabbitmqCh),
            close: sinon.stub().resolves(null)
        };

        mockAmqp = {
            connect: sinon.stub().returns(mockRabbitmqConnection)
        };

        mockRabbitmqConfigObj = {
            schedulerMode: false,
            amqpURI: 'amqp://localhost:5672',
            exchange: 'build',
            connectOptions: '{ json: true, heartbeatIntervalInSeconds: 20, reconnectTimeInSeconds: 30 }'
        };

        mockRedisConfig = {
            connectionDetails: {
                host: '127.0.0.1',
                options: {
                    password: 'test123',
                    tls: false
                },
                port: 6379,
                database: 0
            },
            queuePrefix: '',
            runningJobsPrefix: 'running_job_',
            waitingJobsPrefix: 'waiting_job_'
        };

        mockKafkaConfigObj = {
            kafkaEnabled: 'true',
            shortRegionName: 'true'
        };

        mockKafkaConfig = {
            get: sinon.stub().returns(mockKafkaConfigObj)
        };

        mockRabbitmqConfig = {
            getConfig: sinon.stub().returns(mockRabbitmqConfigObj)
        };

        mockConfig = {
            get: sinon.stub().returns()
        };

        mockExecutorRouter = function() {
            return mockExecutor;
        };

        mockEcosystemConfig = {
            ui: 'foo.ui',
            api: 'foo.api',
            store: 'foo.store',
            cache: {
                strategy: 's3',
                path: '/',
                compress: false,
                md5check: false,
                max_size_mb: 0
            }
        };

        mockProducerSvc = {
            connect: sinon.stub().resolves({}),
            sendMessage: sinon.stub().resolves({})
        };

        helperMock = {
            processHooks: sinon.stub(),
            requestRetryStrategyPostEvent: sinon.stub()
        };

        mockery.registerMock('config', mockConfig);
        mockery.registerMock('screwdriver-executor-router', mockExecutorRouter);
        mockery.registerMock('amqp-connection-manager', mockAmqp);

        mockRedis = sinon.stub().returns(mockRedisObj);
        mockery.registerMock('ioredis', mockRedis);
        mockery.registerMock('../../../config/rabbitmq', mockRabbitmqConfig);
        mockery.registerMock('../../../config/redis', mockRedisConfig);
        mockery.registerMock('../../../config/kafka', mockKafkaConfig);
        mockery.registerMock('../../helper', helperMock);
        mockery.registerMock('screwdriver-aws-producer-service', mockProducerSvc);

        mockBlockedBy = {
            BlockedBy: sinon.stub().returns()
        };
        mockery.registerMock('./BlockedBy', mockBlockedBy);

        mockFilter = {
            Filter: sinon.stub().returns()
        };
        mockCacheFilter = {
            CacheFilter: sinon.stub().returns()
        };
        mockery.registerMock('./Filter', mockFilter);
        mockery.registerMock('./CacheFilter', mockCacheFilter);

        mockConfig.get.withArgs('ecosystem').returns(mockEcosystemConfig);
        mockConfig.get.withArgs('plugins').returns({
            blockedBy: {
                blockTimeout: 120,
                reenqueueWaitTime: 1,
                blockedBySelf: true,
                collapse: true
            }
        });
        mockConfig.get.withArgs('executor').returns(testExecutorConfig);
        // eslint-disable-next-line global-require
        jobs = require('../../../../plugins/worker/lib/jobs');
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('redis constructor', () => {
        it('creates a redis connection given a valid config', () => {
            const expectedPort = 6379;
            const expectedHost = '127.0.0.1';
            const expectedOptions = {
                password: 'test123',
                tls: false
            };

            assert.calledWith(mockRedis, expectedPort, expectedHost, expectedOptions);
        });
    });

    describe('start', async () => {
        it('constructs start job correctly', () =>
            assert.deepEqual(jobs.start, {
                plugins: [mockFilter.Filter, 'Retry', mockBlockedBy.BlockedBy],
                pluginOptions: {
                    Retry: {
                        retryLimit: 3,
                        retryDelay: 5000
                    },
                    BlockedBy: {
                        reenqueueWaitTime: 1,
                        blockTimeout: 120,
                        blockedBySelf: true,
                        collapse: true
                    }
                },
                perform: jobs.start.perform
            }));

        it('starts a job', () => {
            mockExecutor.start.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));

            return jobs.start.perform(partialConfig).then(result => {
                assert.isNull(result);

                assert.calledWith(mockExecutor.start, fullConfig);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
            });
        });

        it('enqueues a start job with scheduler mode', () => {
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            fullConfig.buildClusterName = 'sd';
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            const { amqpURI, exchange, connectOptions } = mockRabbitmqConfigObj;

            return jobs.start.perform(partialConfig).then(result => {
                delete fullConfig.buildClusterName;
                const msg = {
                    job: 'start',
                    buildConfig: fullConfig
                };

                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockAmqp.connect, [amqpURI], connectOptions);
                assert.calledOnce(mockRabbitmqConnection.createChannel);
                assert.calledWith(mockRabbitmqCh.publish, exchange, 'sd', msg, {
                    contentType: 'application/json',
                    persistent: true
                });
                assert.calledOnce(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.start);
            });
        });

        it('close the channel when fail to publish the msg', () => {
            const expectedError = new Error('failed to publish');

            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            fullConfig.buildClusterName = 'sd';
            mockRabbitmqCh.publish.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.calledOnce(mockRabbitmqCh.close);
                    assert.calledOnce(mockRabbitmqConnection.close);
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('raise channelWrapper error and close the channel when publish fails', () => {
            const expectedError = new Error('failed to publish');

            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            fullConfig.buildClusterName = 'sd';
            mockRabbitmqCh.publish.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.calledWith(mockRabbitmqCh.on, 'error');
                    assert.calledOnce(mockRabbitmqCh.close);
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('returns an error from executor', () => {
            mockRedisObj.hget.resolves('{}');
            mockRedisObj.hdel.resolves(1);

            const expectedError = new Error('executor.start Error');

            mockExecutor.start.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('returns an error when redis fails to get a config', () => {
            const expectedError = new Error('hget error');

            mockRedisObj.hget.rejects(expectedError);

            return jobs.start.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('enqueues a start job to kafka queue when kafkaEnabled is true', async () => {
            mockRedisObj.hget.resolves(JSON.stringify(configWithProvider));

            return jobs.start.perform(configWithProvider).then(result => {
                delete configWithProvider.buildClusterName;
                const msg = {
                    job: 'start',
                    executorType: providerConfig.executor,
                    buildConfig: {
                        ...configWithProvider,
                        buildTimeout: 90,
                        uiUri: mockEcosystemConfig.ui,
                        storeUri: mockEcosystemConfig.store
                    }
                };
                const messageId = `start-${configWithProvider.buildId}`;
                const topic = `builds-${providerConfig.accountId}-${providerConfig.region}`;

                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', configWithProvider.buildId);
                assert.notCalled(mockAmqp.connect);
                assert.notCalled(mockRabbitmqConnection.createChannel);
                assert.notCalled(mockRabbitmqCh.publish);
                assert.notCalled(mockExecutor.start);
                assert.calledOnce(mockProducerSvc.connect);
                assert.calledWith(mockProducerSvc.sendMessage, {}, msg, topic, messageId);
                assert.notCalled(mockRabbitmqCh.on);
            });
        });

        it('enqueues a start job to rabbitMQ when kafka is enabled but provider config is not available', async () => {
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            fullConfig.buildClusterName = 'sd';
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));

            return jobs.start.perform(fullConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledOnce(mockAmqp.connect);
                assert.calledOnce(mockRabbitmqConnection.createChannel);
                assert.calledOnce(mockRabbitmqCh.publish);
                assert.notCalled(mockExecutor.start);
                assert.notCalled(mockProducerSvc.connect);
                assert.notCalled(mockProducerSvc.sendMessage);
            });
        });

        it('does not enqueue message to kafka if connection is not available', async () => {
            mockRedisObj.hget.resolves(JSON.stringify(configWithProvider));
            mockProducerSvc.connect.resolves(null);

            return jobs.start.perform(configWithProvider).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', configWithProvider.buildId);
                assert.notCalled(mockAmqp.connect);
                assert.notCalled(mockRabbitmqConnection.createChannel);
                assert.notCalled(mockRabbitmqCh.publish);
                assert.notCalled(mockExecutor.start);
                assert.calledOnce(mockProducerSvc.connect);
                assert.notCalled(mockProducerSvc.sendMessage);
            });
        });
    });

    describe('stop', () => {
        it('constructs stop job correctly', () =>
            assert.deepEqual(jobs.stop, {
                plugins: [mockFilter.Filter, 'Retry'],
                pluginOptions: {
                    Retry: {
                        retryLimit: 3,
                        retryDelay: 5000
                    }
                },
                perform: jobs.stop.perform
            }));

        it('do not call executor stop if job has not started', () => {
            const stopConfig = { started: false, ...partialConfig };

            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves('1000');

            return jobs.stop.perform(stopConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', fullConfig.buildId);
                assert.notCalled(mockRedisObj.del);
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, fullConfig.buildId);
                assert.notCalled(mockExecutor.stop);
            });
        });

        it('stops a job', () => {
            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves(fullConfig.buildId);

            return jobs.stop.perform(fullConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.del, 'running_job_777');
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, fullConfig.buildId);
                assert.calledWith(mockExecutor.stop, {
                    buildId: 8609,
                    annotations: { 'beta.screwdriver.cd/executor': 'k8s' },
                    jobId: 777,
                    jobName: 'main',
                    blockedBy: [777],
                    container: 'node:4',
                    apiUri: 'http://api.com'
                });
            });
        });

        it('enqueues a stop job with scheduler mode', () => {
            fullConfig.buildClusterName = 'sd';
            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(fullConfig));
            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves(fullConfig.buildId);
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            const { amqpURI, exchange, connectOptions } = mockRabbitmqConfigObj;

            return jobs.stop.perform(fullConfig).then(result => {
                delete fullConfig.buildClusterName;
                const msg = {
                    job: 'stop',
                    buildConfig: fullConfig
                };

                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockRedisObj.del, 'running_job_777');
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, fullConfig.buildId);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockAmqp.connect, [amqpURI], connectOptions);
                assert.calledOnce(mockRabbitmqConnection.createChannel);
                assert.calledWith(mockRabbitmqCh.publish, exchange, 'sd', msg, {
                    contentType: 'application/json',
                    persistent: true
                });
                assert.calledOnce(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.stop);
                assert.calledWith(mockRabbitmqCh.on, 'error');
            });
        });

        it('enqueues a stop job to kafka queue when kafkaEnabled is true', () => {
            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.resolves(JSON.stringify(configWithProvider));

            mockRedisObj.hdel.resolves(1);
            mockRedisObj.del.resolves(null);
            mockRedisObj.get.withArgs('running_job_777').resolves(configWithProvider.buildId);

            return jobs.stop.perform(configWithProvider).then(result => {
                delete configWithProvider.buildClusterName;
                const msg = {
                    job: 'stop',
                    executorType: providerConfig.executor,
                    buildConfig: {
                        ...configWithProvider,
                        buildTimeout: 90,
                        uiUri: mockEcosystemConfig.ui,
                        storeUri: mockEcosystemConfig.store
                    }
                };
                const messageId = `stop-${configWithProvider.buildId}`;
                const topic = `builds-${providerConfig.accountId}-${providerConfig.region}`;

                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', configWithProvider.buildId);
                assert.calledWith(mockRedisObj.hdel, 'buildConfigs', configWithProvider.buildId);
                assert.calledWith(mockRedisObj.del, 'running_job_777');
                assert.calledWith(mockRedisObj.lrem, 'waiting_job_777', 0, configWithProvider.buildId);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', configWithProvider.buildId);
                assert.notCalled(mockAmqp.connect);
                assert.notCalled(mockRabbitmqConnection.createChannel);
                assert.notCalled(mockRabbitmqCh.publish);
                assert.notCalled(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.stop);
                assert.calledOnce(mockProducerSvc.connect);
                assert.calledWith(mockProducerSvc.sendMessage, {}, msg, topic, messageId);
                assert.notCalled(mockRabbitmqCh.on);
            });
        });

        it('stop a build anyway when redis fails to get a config', () => {
            const expectedError = new Error('hget error');

            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.rejects(expectedError);

            return jobs.stop.perform(partialConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.calledWith(mockExecutor.stop, {
                    buildId: fullConfig.buildId,
                    jobName: fullConfig.jobName,
                    jobId: fullConfig.jobId
                });
            });
        });

        it('does not enqueue a stop message to kafka when redis fails to get a config', () => {
            const expectedError = new Error('hget error');

            mockExecutor.stop.resolves(null);
            mockRedisObj.hget.rejects(expectedError);

            return jobs.stop.perform(partialConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', fullConfig.buildId);
                assert.notCalled(mockProducerSvc.connect);
                assert.notCalled(mockProducerSvc.sendMessage);
                assert.calledWith(mockExecutor.stop, {
                    buildId: fullConfig.buildId,
                    jobName: fullConfig.jobName,
                    jobId: fullConfig.jobId
                });
            });
        });

        it('returns an error from stopping executor', () => {
            const expectedError = new Error('executor.stop Error');

            mockRedisObj.hget.resolves('{}');
            mockRedisObj.hdel.resolves(1);
            mockExecutor.stop.rejects(expectedError);

            return jobs.stop.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });

        it('returns an error when redis fails to remove a config', () => {
            const expectedError = new Error('hdel error');

            mockRedisObj.hget.resolves('{}');
            mockRedisObj.hdel.rejects(expectedError);

            return jobs.stop.perform({}).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.deepEqual(err, expectedError);
                }
            );
        });
    });

    describe('clear', () => {
        let amqpURI;
        let exchange;
        let connectOptions;

        beforeEach(() => {
            mockRabbitmqConfigObj.schedulerMode = true;
            mockRabbitmqConfig.getConfig.returns(mockRabbitmqConfigObj);
            ({ amqpURI, exchange, connectOptions } = mockRabbitmqConfigObj);
            mockRedisObj.hget.resolves(null);
        });
        it('constructs clear job correctly', () =>
            assert.deepEqual(jobs.clear, {
                plugins: [mockCacheFilter.CacheFilter, 'Retry'],
                pluginOptions: {
                    Retry: {
                        retryLimit: 3,
                        retryDelay: 5000
                    }
                },
                perform: jobs.clear.perform
            }));
        it('do not publish to rabbitmq if cache config is missing buildClusters', () => {
            const cacheConfig = { id: 123 };

            mockCacheFilter.CacheFilter.returns(false);

            return jobs.clear.perform(cacheConfig).then(result => {
                assert.isNull(result);
                assert.notCalled(mockRabbitmqConnection.createChannel);
                assert.notCalled(mockRabbitmqCh.publish);
                assert.notCalled(mockRabbitmqCh.close);
            });
        });

        it('publish to rabbitmq for valid cache config and scheduler enabled', () => {
            const cacheConfig = {
                id: 123,
                resource: 'caches',
                scope: 'builds',
                buildClusters: [],
                action: 'delete'
            };

            mockRedisObj.hget.resolves(JSON.stringify({ buildClusterName: 'sd1', pipelineId: 1234 }));

            return jobs.clear.perform(cacheConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', cacheConfig.id);
                assert.calledWith(mockAmqp.connect, [amqpURI], connectOptions);
                assert.calledOnce(mockRabbitmqConnection.createChannel);
                assert.calledWith(
                    mockRabbitmqCh.publish,
                    exchange,
                    'sd1',
                    { cacheConfig, job: 'clear' },
                    {
                        contentType: 'application/json',
                        persistent: true
                    }
                );
                assert.calledOnce(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.stop);
            });
        });

        it('publish to all rabbitmq queues specified in buildCluster', () => {
            const cacheConfig = {
                id: 123,
                resource: 'caches',
                scope: 'builds',
                buildClusters: ['sd1', 'sd2'],
                action: 'delete'
            };

            return jobs.clear.perform(cacheConfig).then(result => {
                assert.deepEqual(result, null);
                assert.calledWith(mockRedisObj.hget, 'buildConfigs', cacheConfig.id);
                assert.calledWith(mockAmqp.connect, [amqpURI], connectOptions);
                assert.calledTwice(mockRabbitmqConnection.createChannel);
                assert.calledWith(
                    mockRabbitmqCh.publish,
                    exchange,
                    'sd1',
                    { cacheConfig, job: 'clear' },
                    {
                        contentType: 'application/json',
                        persistent: true
                    }
                );
                assert.calledWith(
                    mockRabbitmqCh.publish,
                    exchange,
                    'sd2',
                    { cacheConfig, job: 'clear' },
                    {
                        contentType: 'application/json',
                        persistent: true
                    }
                );
                assert.calledTwice(mockRabbitmqCh.close);
                assert.notCalled(mockExecutor.stop);
            });
        });
    });

    describe('sendWebhook', () => {
        it('constructs sendWebhook job correctly', () =>
            assert.deepEqual(jobs.sendWebhook, {
                plugins: ['Retry'],
                pluginOptions: {
                    Retry: {
                        retryLimit: 3,
                        retryDelay: 5000
                    }
                },
                perform: jobs.sendWebhook.perform
            }));

        it('send message to processHooks API', () => {
            const webhookConfig = JSON.stringify({
                webhookConfig: { foo: 123 },
                token: 'test_token'
            });

            return jobs.sendWebhook.perform(webhookConfig).then(result => {
                assert.isNull(result);
                assert.calledWith(
                    helperMock.processHooks,
                    'foo.api',
                    'test_token',
                    { foo: 123 },
                    helperMock.requestRetryStrategyPostEvent
                );
            });
        });

        it('returns an error when webhookConfig is not a string in JSON format', () => {
            const webhookConfig = 'foo';

            return jobs.sendWebhook.perform(webhookConfig).then(
                () => {
                    assert.fail('Should not get here');
                },
                err => {
                    assert.notCalled(mockExecutor.tokenGen);
                    assert.notCalled(helperMock.processHooks);
                    assert.strictEqual(err.name, 'SyntaxError');
                    assert.strictEqual(err.message, 'Unexpected token o in JSON at position 1');
                }
            );
        });
    });
});
