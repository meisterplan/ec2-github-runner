const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=false',
      'export INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id)',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --name $INSTANCE_ID --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.284.0/actions-runner-linux-${RUNNER_ARCH}-2.284.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.284.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=false',
      'export INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id)',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --name $INSTANCE_ID --labels ${label}`,
      './run.sh',
    ];
  }
}

async function tryEc2Instance(label, githubRegistrationToken, subnetId) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
  };

  const result = await ec2.runInstances(params).promise();
  const ec2InstanceId = result.Instances[0].InstanceId;
  const instanceDescribe = await ec2.describeInstances({ InstanceIds: [ec2InstanceId] }).promise();
  core.info(
    `AWS EC2 instance ${ec2InstanceId} is started (label=${label}, hostname=${instanceDescribe.Reservations[0].Instances[0].PrivateDnsName})`
  );
  return ec2InstanceId;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const subnets = config.input.subnetId
    .split(',')
    // shuffle subnets using the schwartzian transform algorithm
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
  for (const subnet of subnets) {
    try {
      return await tryEc2Instance(label, githubRegistrationToken, subnet);
    } catch (e) {
      core.warning(`Failed to launch instance in subnet ${subnet}: ${e.toString()}`);
    }
  }
  core.error(`Exhausted subnets to try to launch EC2 instance, permanent failure of instance launch.`);
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
