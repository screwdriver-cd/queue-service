FROM node:18

# Screwdriver Version
ARG VERSION=latest

# Create our application directory
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

# Install Screwdriver Queue Service
RUN npm install screwdriver-queue-service@$VERSION
WORKDIR /usr/src/app/node_modules/screwdriver-queue-service

# Setup configuration folder
# This layer is rebuilt when a file changes in the project directory
RUN cp -r /usr/src/app/node_modules/screwdriver-queue-service/config /config

# Expose the web service port
EXPOSE 8080

# Add Tini
ENV TINI_VERSION v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini
ENTRYPOINT ["/tini", "--"]

# Run the service
CMD [ "node", "./bin/server" ]
