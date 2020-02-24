'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Register Plugins', () => {
    const resourcePlugins = [
        'worker',
        'queue',
        'status'
    ];
    const defaultPlugin = [
        'blipp'
    ];
    const pluginLength = resourcePlugins.length + defaultPlugin.length;
    const mocks = {};
    const config = {};
    let main;
    let serverMock;

    before(() => {
        mockery.enable({
            warnOnUnregistered: false,
            useCleanCache: true
        });
    });

    beforeEach(() => {
        serverMock = {
            register: sinon.stub(),
            on: sinon.stub()
        };
        resourcePlugins.forEach((plugin) => {
            mocks[plugin] = sinon.stub();
            mockery.registerMock(plugin, mocks[plugin]);
        });

        /* eslint-disable global-require */
        main = require('../../lib/registerPlugins');
        /* eslint-enable global-require */
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        main = null;
    });

    after(() => {
        mockery.disable();
    });

    it('registered resource plugins', () => {
        serverMock.register.callsArgWithAsync(1);

        return main(serverMock, config).then(() => {
            assert.equal(serverMock.register.callCount, pluginLength);

            resourcePlugins.forEach((plugin) => {
                assert.calledWith(serverMock.register, {
                    plugin: mocks[plugin],
                    options: {
                        name: plugin
                    },
                    routes: {
                        prefix: '/v1'
                    }
                });
            });
        });
    });

    it.skip('bubbles failures up', () => {
        serverMock.register.callsArgWithAsync(2, new Error('failure loading'));

        return main(serverMock, config)
            .then(() => {
                throw new Error('should not be here');
            })
            .catch((err) => {
                assert.equal(err.message, 'failure loading');
            });
    });

    it.skip('registers data for plugin when specified in the config object', () => {
        serverMock.register.callsArgAsync(2);

        return main(serverMock, {
            auth: {
                foo: 'bar'
            }
        }).then(() => {
            assert.equal(serverMock.register.callCount, pluginLength);

            assert.calledWith(serverMock.register, {
                register: mocks['../plugins/queue'],
                options: {
                    foo: 'bar'
                }
            }, {
                routes: {
                    prefix: '/v1'
                }
            });
        });
    });
});
