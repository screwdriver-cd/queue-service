'use strict';

const chai = require('chai');
const { assert, expect } = chai;
const hapi = require('@hapi/hapi');
const sinon = require('sinon');
const chaiJWT = require('chai-jwt');
const mockery = require('mockery');

chai.use(chaiJWT);

sinon.assert.expose(assert, { prefix: '' });

describe('auth plugin test', () => {
    let plugin;
    let authPlugin;
    let server;
    const jwtPrivateKey = 'test key';
    const jwtPublicKey = 'test public key';
    const jwtSDApiPublicKey = 'test api pubclic key';

    beforeEach(async () => {
        /* eslint-disable global-require */
        plugin = require('../../../plugins/auth');
        authPlugin = require('hapi-auth-jwt2');
        /* eslint-enable global-require */
        server = new hapi.Server({
            port: 1234
        });

        await server.register({ plugin: authPlugin });
        await server.register({
            plugin,
            options: {
                jwtPrivateKey,
                jwtPublicKey,
                jwtSDApiPublicKey
            }
        });
    });

    afterEach(() => {
        server = null;
    });

    describe('constructor', () => {
        it('registers the auth plugin', () => {
            assert.isOk(server.registrations.auth);
        });

        it('registers the hapi-auth-jwt2 plugin', () => {
            assert.isOk(server.registrations['hapi-auth-jwt2']);
        });
    });

    it('throws exception when config not passed', async () => {
        const testServer = new hapi.Server({
            port: 1234
        });

        await testServer.register({ plugin: authPlugin });

        try {
            await testServer.register({
                plugin,
                options: {}
            });
        } catch (err) {
            assert.exists(err, 'Invalid config for plugin-auth');
        }
    });

    describe('generate profiles', () => {
        beforeEach(() => {
            server = new hapi.Server({
                port: 1234
            });
            server.register({ plugin: authPlugin });
            server.register({
                plugin,
                options: {
                    jwtPrivateKey,
                    jwtPublicKey,
                    jwtSDApiPublicKey,
                    admins: ['github:batman', 'batman']
                }
            });
        });

        it('adds environment', async () => {
            const newServer = new hapi.Server({
                port: 1234
            });

            await newServer.register({ plugin: authPlugin });
            await newServer.register({
                plugin,
                options: {
                    jwtPrivateKey,
                    jwtPublicKey,
                    jwtSDApiPublicKey,
                    jwtEnvironment: 'beta'
                }
            });

            const profile = newServer.plugins.auth.generateProfile('batman', 'github:github.com', ['user'], {});

            expect(profile.environment).to.equal('beta');
        });

        it('adds admin scope for admins', () => {
            const profile = server.plugins.auth.generateProfile('batman', 'github:github.com', ['user'], {});

            expect(profile.username).to.contain('batman');
            expect(profile.scmContext).to.contain('github:github.com');
            expect(profile.scope).to.contain('user');
            expect(profile.scope).to.contain('admin');
            expect(profile.environment).to.equal(undefined);
        });

        it('does not add admin scope for non-admins', () => {
            const profile = server.plugins.auth.generateProfile('robin', 'github:mygithub.com', ['user'], {});

            expect(profile.username).to.contain('robin');
            expect(profile.scmContext).to.contain('github:mygithub.com');
            expect(profile.scope).to.contain('user');
            expect(profile.scope).to.not.contain('admin');
            expect(profile.environment).to.equal(undefined);
        });
    });
});

describe('generate tokens', () => {
    let plugin;
    let authPlugin;
    let server;
    const jwtPrivateKey = 'test key';
    const jwtPublicKey = 'test public key';
    const jwtSDApiPublicKey = 'test api pubclic key';
    const mockJWT =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaXBlbGluZUlkIjoxLCJzZXJ2aWNlIjoicXVldWUiLCJqb2JJZCI6Miwic2NtQ29udGV4dCI6ImdpdGh1YjpnaXRodWIuY29tIiwic2NvcGUiOlsidXNlciJdLCJpYXQiOjE1ODQxMzk4MjcsImV4cCI6MTU4NDE0MzQyNywianRpIjoiY2FjNzQwNTYtNzRhOC00NWQ0LWJkMTQtZTFlMDY2YjJiZjVhIn0.vrtA3NAaBYwCOxZDBUxlMciyrra0zlXuyw4eyUeXj-Q7i-NS_SNFOycjmcKGe9qjg5MZ4dUMc5fxdsYsPqKHruweGgZ9HXbK21653EH5SWQsMpYe8yOp_Q-20EwXxq0iT5ukptIUOhvwJ1_ciwsf8w4tJoANvfcn62fRAY5gFOFFf7YCeHqiR1TaaVTOLT2vLrha4e6QTUv16eZ-XTg0nB84dp_RYN5ep2jTdCPaIDw2HlWb29EdpheRpIBnemm3hL1VtuGh_IcoVmADe1UBHlxC1TPNtuzjvxqDuIu20ADi5NVa30Hf1Xqi-RkoMzC5bmAYCzGjYVd8LjHMfuJZ7lr473ZbN0CRDqIWagskxwzn-rj1AUL7vDwXkZzEbPlj1foz7mTE4cukkLNPHTVCOAGJlYRfFbSkkspO1zN3tccreg9QGiJukMvLUrf4_gRztpbyTStKiIQw-5qLvwSlt0QFoCtR_RtOHvhoT6aBLt7weW3eef8-f1l0wheS41B8qcaZCNIQZEmT2PppPN8mjACHF0vnWmV5I5IbH5iqnt6JhFdgmtoEJKjCdo4w3lCDKcirHMSZ0uUOmlyiaqNF5NtpNLqbUCCM6w6csjTgfSBrK-GUyvQB7XWMvLznwluWyfYYFXR79yDwghVIu9fS6j2E9ywv-toLUSM-8cGSeY4';

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });
    beforeEach(() => {
        mockery.registerMock('jsonwebtoken', {
            sign: sinon.stub().returns(mockJWT)
        });

        /* eslint-disable global-require */
        plugin = require('../../../plugins/auth');
        authPlugin = require('hapi-auth-jwt2');
        /* eslint-enable global-require */

        server = new hapi.Server({
            port: 1234
        });
        server.register({ plugin: authPlugin });
        server.register({
            plugin,
            options: {
                jwtPrivateKey,
                jwtPublicKey,
                jwtSDApiPublicKey,
                admins: ['github:batman', 'batman']
            }
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    it('returns token for profile request', () => {
        const token = server.plugins.auth.generateToken({
            pipelineId: 1,
            service: 'queue',
            jobId: 3,
            scmContext: 'github:github.com',
            scope: ['user']
        });

        expect(token).to.be.a.jwt.and.have.claim('scope');
        expect(token).to.be.a.jwt.and.eql({
            pipelineId: 1,
            service: 'queue',
            jobId: 2,
            scmContext: 'github:github.com',
            scope: ['user'],
            exp: 1584143427,
            iat: 1584139827,
            jti: 'cac74056-74a8-45d4-bd14-e1e066b2bf5a'
        });
    });
});
