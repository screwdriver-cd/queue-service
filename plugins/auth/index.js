'use strict';

const joi = require('joi');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const DEFAULT_TIMEOUT = 60; // 1h in minutes
const ALGORITHM = 'RS256';

const validate = async function () {
    // The _decoded token signature is validated by jwt.veriry so we can return true
    return { isValid: true };
};

const authPlugin = {
    name: 'auth',
    async register(server, options) {
        const pluginOptions = joi.attempt(
            options,
            joi.object().keys({
                jwtEnvironment: joi.string().default(''),
                jwtPrivateKey: joi.string().required(),
                jwtPublicKey: joi.string().required(),
                jwtSDApiPublicKey: joi.string().required(),
                admins: joi.array().default([])
            }),
            'Invalid config for plugin-auth'
        );

        server.auth.strategy('token', 'jwt', {
            key: [pluginOptions.jwtPublicKey, pluginOptions.jwtSDApiPublicKey],
            verifyOptions: {
                algorithms: [ALGORITHM]
            },
            validate
        });

        server.auth.scheme('custom', () => {
            return {
                authenticate: (_, h) => {
                    return h.authenticated();
                }
            };
        });
        server.auth.strategy('default', 'custom');

        /**
         * Generates a profile for storage in cookie and jwt
         * @method generateProfile
         * @param  {String}        username   Username of the person
         * @param  {String}        scmContext Scm to which the person logged in belongs
         * @param  {Array}         scope      Scope for this profile (usually build or user)
         * @param  {Object}        metadata   Additonal information to tag along with the login
         * @return {Object}                   The profile to be stored in jwt and/or cookie
         */
        server.expose('generateProfile', (username, scmContext, scope, metadata) => {
            const profile = { username, scmContext, scope, ...(metadata || {}) };

            if (pluginOptions.jwtEnvironment) {
                profile.environment = pluginOptions.jwtEnvironment;
            }

            if (scmContext) {
                // Check admin
                if (pluginOptions.admins.length > 0 && pluginOptions.admins.includes(username)) {
                    profile.scope.push('admin');
                }
            }

            return profile;
        });

        /**
         * Generates a jwt that is signed and has a lifespan (default:1h)
         * @method generateToken
         * @param  {Object}  profile        Object from generateProfile
         * @param  {Integer} buildTimeout   JWT Expires time (must be minutes)
         * @return {String}                 Signed jwt that includes that profile
         */
        server.expose('generateToken', (profile, buildTimeout = DEFAULT_TIMEOUT) =>
            jwt.sign(profile, pluginOptions.jwtPrivateKey, {
                algorithm: ALGORITHM,
                expiresIn: buildTimeout * 60, // must be in second
                jwtid: uuidv4()
            })
        );
    }
};

module.exports = authPlugin;
