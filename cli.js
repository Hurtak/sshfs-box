#!/usr/bin/env node

"use strict";

const os = require("os");
const fs = require("fs-extra");
const path = require("path");
const meow = require("meow");
const chalk = require("chalk");
const execa = require("execa");
const inquirer = require("inquirer");
const isInvalidPath = require("is-invalid-path");
const indentString = require("indent-string");

// Global variables

const configDir = path.join(os.homedir(), ".config");
const configPath = path.join(configDir, "sshfs-box.json");
const promptPageSize = 16; // https://github.com/SBoudrias/Inquirer.js/#question

// CLI

const cli = meow(
  `
  CLI tool to manage remote directories with SSHFS.

  Usage
    $ sshfs-box

  Options
    --config, -c  Configure remote & local paths
                  Config stored in ~/.config/sshfs-box.json
`,
  {
    flags: {
      config: {
        type: "boolean",
        alias: ["c", "configure"],
      },
    },
  }
);

//
// Main
//

async function main() {
  let configString;
  try {
    configString = await fs.readFile(configPath, "utf8");
  } catch (e) {
    stdoutNewline(1);
    stdout(`Can't find config "${configPath}", creating new config`);
    stdoutNewline(1);
    const config = await promptEditConfig();
    await promptSshfs(config);
    return;
  }

  if (cli.flags.config) {
    const config = await promptEditConfig(configString);
    await promptSshfs(config);
  } else {
    const [configValid, errorMessage] = validateConfigString(configString);
    if (configValid) {
      const config = JSON.parse(configString);
      await promptSshfs(config);
    } else {
      stdoutNewline(1);
      stdoutError({
        title: `"${
          configPath
        }" does not contain valid config, opening editor so you can fix it`,
        err: errorMessage,
      });

      const config = await promptEditConfig(configString);
      await promptSshfs(config);
    }
  }
}

main(); // Start the app.

//
// Prompt functions.
//

async function promptEditConfig(defaultConfigOverride) {
  const defaultConfig = JSON.stringify(
    {
      urls: [
        "username@host1:",
        "username@host2:/home/username",
        "username@host2:/www",
      ],
      folder: path.join(os.homedir(), "remote"),
    },
    null,
    2
  );

  const promptSettings = {
    type: "editor",
    name: "config",
    message: "Configure sshfs-box",
    default: defaultConfigOverride || defaultConfig,
    validate: userInput => {
      const [valid, err] = validateConfigString(userInput);
      // Inquirer expects true if input is valid, otherwise string error message.
      return valid ? true : err;
    },
  };

  stdoutNewline(1);
  const response = await inquirer.prompt(promptSettings);

  const configString = response.config;
  const config = JSON.parse(configString);

  try {
    await fs.outputFile(configPath, configString, "utf8");
  } catch (err) {
    stdoutError({
      title: `Unable to write config file "${configPath}"`,
      err: err,
    });
    process.exit(1);
  }

  stdoutNewline(1);
  stdout(`Config succesfully saved to "${configPath}"`);
  stdoutNewline(1);

  return config;
}

async function promptSshfs(config) {
  let mountStr;
  try {
    mountStr = await execa.shellSync("mount");
  } catch (err) {
    stdoutError({
      title: `Error while getting SSHFS mounted folders, exiting`,
      err: err,
    });
    stdoutNewline(1);
    process.exit(1);
  }

  const mounted = mountStr.stdout.split(os.EOL);

  const destinations = config.urls.map(remote => {
    // username@host:/dir/subdir => username@host:-dir-subdir
    const local = path.join(config.folder, remote.replace(/[/]/g, "-"));

    const isChecked = isMountedWithMount(mounted, remote, local);

    return {
      name: `${remote} ↔ ${local}`,
      checked: isChecked,
      remote: remote,
      local: local,
    };
  });

  stdoutNewline(1);
  const response = await inquirer.prompt({
    type: "checkbox",
    message: "SSHFS mount/unmount dirs",
    name: "urls",
    choices: destinations,
    pageSize: promptPageSize,
  });
  stdoutNewline(1);

  const selectedUrls = response.urls;

  // Mount selected items that are not already mounted.
  const mountItems = selectedUrls
    .map(url => destinations.find(item => item.name === url))
    .filter(item => !isMountedWithMount(mounted, item.remote, item.local));

  for (const mountItem of mountItems) {
    try {
      await fs.ensureDir(mountItem.local);
    } catch (err) {
      stdoutError({
        title: mountItem.remote,
        description: `Error while creating local directory "${
          mountItem.local
        }"`,
        err: err,
      });
      continue;
    }

    try {
      await execa("sshfs", [mountItem.remote, mountItem.local]);
    } catch (err) {
      stdoutError({
        title: mountItem.remote,
        description: `Error while mounting`,
        err: err,
      });
      continue;
    }

    stdoutMounted(mountItem.remote);
  }

  // Unmount items that have been unselected.
  const unmountItems = destinations
    .filter(item => !selectedUrls.includes(item.name))
    .filter(item => isMountedWithMount(mounted, item.remote, item.local));
  let unmountErrors = [];
  for (const item of unmountItems) {
    const unmountSuccesful = await unmount(item);
    if (!unmountSuccesful) {
      unmountErrors.push(item);
      continue;
    }
  }

  // Force unmount.
  if (unmountErrors.length > 0) {
    const forceUnmountChoices = unmountErrors.map(choice => {
      choice.checked = false;
      return choice;
    });

    stdoutNewline(1);
    const answer = await inquirer.prompt({
      type: "checkbox",
      message:
        "There were poblems with unmomunting, force unmount by killing SSHFS process?",
      name: "urls",
      choices: forceUnmountChoices,
      pageSize: promptPageSize,
    });
    stdoutNewline(1);

    const forceUnmountUrls = answer.urls;

    const forceUnmountItems = forceUnmountUrls.map(url =>
      destinations.find(item => item.name === url)
    );

    let responsePsx = null;
    try {
      responsePsx = await execa("ps", ["-x"]);
    } catch (err) {
      stdoutError({
        title: `Error while running "ps -x" command`,
        err: err,
      });
      return;
    }

    const processes = responsePsx.stdout.split(os.EOL);
    if (!processes) {
      stdoutError({
        title: `After running "ps -x" we were unable to find any SSHFS processes`,
      });
      return;
    }

    for (const item of forceUnmountItems) {
      const processRow = processes.find(row =>
        row.includes(`sshfs ${item.remote} ${item.local}`)
      );
      if (!processRow) {
        stdoutError({
          title: item.remote,
          description: `Unable to find "${item.local}" SSHFS process`,
        });
        continue;
      }
      const pidMatches = processRow.match(/^\s*\d+/);
      const processId = pidMatches.length > 0 ? pidMatches[0] : null;

      if (!processId) {
        stdoutError({
          title: item.remote,
          description: `Unable to parse SSHFS process id`,
        });
        continue;
      }

      let processKilled = false;
      try {
        await execa("kill", ["-9", processId]);
        processKilled = true;
      } catch (err) {
        stdoutError({
          title: item.remote,
          description: `Unable to kill SSHFS process with id "${processId}"`,
          err: err,
        });
        continue;
      }
      if (processKilled) {
        stdoutUnmountForce(item.remote, processId);
      }

      await unmount(item);
    }
  }
}

function isMountedWithMount(mountRows, remote, local) {
  return mountRows.some(mount => mount.startsWith(remote + " on " + local));
}

async function unmount(item) {
  try {
    await execa("fusermount", ["-u", item.local]);
  } catch (err) {
    stdoutError({
      title: item.remote,
      description: `Unable to unmount`,
      err: err,
    });
    return false;
  }
  stdoutUnmounted(item.remote);

  try {
    await fs.rmdir(item.local);
  } catch (err) {
    stdoutError({
      title: item.remote,
      description: `Unable to remove directory ${item.local}`,
      err: err,
    });
  }

  return true;
}

//
// Utility functions
//

function validateConfigString(configString) {
  let config;
  try {
    config = JSON.parse(configString);
  } catch (e) {
    return [false, "Error parsing JSON"];
  }

  if (!config.urls) {
    return [false, `The "urls" field is missing or empty`];
  } else if (!Array.isArray(config.urls)) {
    return [false, `The "urls" filed is not an array`];
  } else if (!config.urls.every(item => typeof item === "string")) {
    return [false, `All items in "urls" filed need to be string`];
  }

  const invalidPathInUrls = config.urls.find(path => isInvalidPath(path));
  if (invalidPathInUrls) {
    return [false, `"${invalidPathInUrls}" is not a valid path`];
  } else if (!config.folder) {
    return [false, `The "folder" field is missing or empy`];
  } else if (typeof config.folder !== "string") {
    return [false, `The "folder" field must be string`];
  } else if (isInvalidPath(config.folder)) {
    return [false, `The "folder" field does not contain a valid path`];
  }

  return [true, null];
}

function removeTrailingNewlines(str) {
  while (str.endsWith(os.EOL)) {
    str = str.slice(0, str.length - os.EOL.length);
  }
  return str;
}

function stdout(input) {
  process.stdout.write(input);
}

function stdoutError({ title, description, err }) {
  stdout(chalk.bgRed(`[ERROR] ${title}`));
  stdoutNewline(1);

  if (description) {
    stdout(indentString(description, 4));
    stdoutNewline(1);
  }

  if (err) {
    let errFormatted = err;
    errFormatted = String(errFormatted);
    errFormatted = removeTrailingNewlines(errFormatted);
    errFormatted = indentString(errFormatted, 4);
    stdout(errFormatted);
    stdoutNewline(1);
  }
}

function stdoutMounted(input) {
  stdout(chalk.green(`[MOUNTED] ${input}`));
  stdoutNewline(1);
}

function stdoutUnmounted(input) {
  stdout(chalk.blue(`[UNMOUNTED] ${input}`));
  stdoutNewline(1);
}

function stdoutUnmountForce(input, precessId) {
  stdout(chalk.bgBlue(`[SSHFS PROCESS KILLED] ${input}`));
  stdoutNewline(1);
  stdout(indentString(`Killed process with id "${precessId}"`, 4));
  stdoutNewline(1);
}

function stdoutNewline(number = 1) {
  let newlines = "";
  for (let i = 0; i < number; i++) {
    newlines += os.EOL;
  }
  stdout(newlines);
}
