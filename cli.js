#!/usr/bin/env node

/*
  TODO
    print processRow when killing
    rename?
    docs
      unify description in meow readme and package.json
    gifs
    mention on twitter
*/

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const meow = require("meow");
const chalk = require("chalk");
const execa = require("execa");
const inquirer = require("inquirer");
const indentString = require("indent-string");

// Global variables

const configDir = path.join(os.homedir(), ".config");
const configPath = path.join(configDir, "sshfs-box.json");

// CLI

const cli = meow(
  `
  Small CLI tool to mount/unmount directories remote servers with SSHFS.

  Usage
    $ sshfs-box

  Options
    --config, -c  Configure remote & local paths
                  Config stored in ~/.config/sshfs-box.json
`,
  {
    alias: {
      c: "config",
      configure: "config",
      settings: "config",
    },
  }
);

// Main

async function main() {
  let configString;
  try {
    configString = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    stdout(`Can't open config on ${configPath}, creating new config`);
    stdoutNewline(2);
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
      await promptSshfs(JSON.parse(configString));
    } else {
      stdoutError({
        title: `${
          configPath
        } does not contain valid config, opening editor so you can fix it`,
        err: errorMessage,
      });

      stdoutNewline(2);
      const config = await promptEditConfig(configString);
      await promptSshfs(config);
    }
  }

  stdoutNewline(1);
}

main(); // Start the app.

// Prompt functions.

async function promptEditConfig(defaultConfigOverride) {
  const defaultConfig = JSON.stringify(
    {
      urls: ["user@host1:", "user@host2:/home/user", "user@host2:/www"],
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
    fs.mkdirSync(configDir);
  } catch (e) {
    // TODO.
  }

  fs.writeFileSync(configPath, configString, "utf8");

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

    return;
  }

  const mounted = mountStr.stdout.split(os.EOL);

  const data = config.urls.map(remote => {
    // user@host:/dir/subdir => user@host--dir-subdir
    const local = path.join(
      config.folder,
      remote.replace(/:/g, "-").replace(/\//g, "-")
    );

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
    choices: data,
  });
  const selectedUrls = response.urls;

  // mount selected items that are not already mounted
  const mountItems = selectedUrls
    .map(url => data.find(item => item.name === url))
    .filter(item => !isMountedWithMount(mounted, item.remote, item.local));

  for (const mountItem of mountItems) {
    try {
      await execa("mkdir", ["-p", mountItem.local]);
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
        description: `Error while mounting "${mountItem.name}"`,
        err: err,
      });
      continue;
    }

    stdoutMounted(mountItem.remote);
  }

  // unmount items that have been unselected
  const unmountItems = data
    .filter(item => !selectedUrls.includes(item.name))
    .filter(item => isMountedWithMount(mounted, item.remote, item.local));
  let unmountErrors = [];
  for (const data of unmountItems) {
    const unmountSuccesful = await unmount(data);
    if (!unmountSuccesful) {
      unmountErrors.push(data);
      continue;
    }

    // TODO async
    // TODO error handling
    execa.sync("rm", ["-r", data.local]);
  }

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
    });
    const forceUnmountUrls = answer.urls;

    const forceUnmountItems = forceUnmountUrls.map(url =>
      data.find(item => item.name === url)
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
      const pid = pidMatches.length > 0 ? pidMatches[0] : null;

      if (!pid) {
        stdoutError({
          title: item.remote,
          description: `Unable to parse SSHFS process id`,
        });
        continue;
      }

      let processKilled = false;
      try {
        await execa("kill", ["-9", pid]);
        processKilled = true;
      } catch (err) {
        stdoutError({
          title: item.remote,
          description: `Unable to kill SSHFS process with id "${pid}"`,
          err: err,
        });
        continue;
      }
      if (processKilled) {
        // console.log(processRow);
        stdoutUnmountForce(item.remote);
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
  return true;
}

// Utility functions

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
  } else if (config.urls.some(item => typeof item !== "string")) {
    return [false, `All fields in "urls" filed need to be string`];
  } else if (!config.folder) {
    return [false, `The "folder" field is missing or empy`];
  } else if (typeof config.folder !== "string") {
    return [false, `The "folder" field must be string`];
  }

  return [true, null];
}

function removeTrailingNewline(str) {
  if (str.endsWith(os.EOL)) {
    return str.slice(0, str.length - os.EOL.length);
  }
  return str;
}

function stdout(input) {
  process.stdout.write(input);
}

function stdoutError({ title, description, err }) {
  stdoutNewline(1);
  stdout(chalk.bgRed(`[ERROR] ${title}`));

  if (description) {
    stdoutNewline(1);
    stdout(indentString(description, 4));
  }

  if (err) {
    stdoutNewline(1);

    let errFormatted = err;
    errFormatted = String(errFormatted);
    errFormatted = removeTrailingNewline(errFormatted);
    errFormatted = indentString(errFormatted, 4);
    stdout(errFormatted);
  }
}

function stdoutMounted(input) {
  stdoutNewline(1);
  stdout(chalk.green(`[MOUNTED] ${input}`));
}

function stdoutUnmounted(input) {
  stdoutNewline(1);
  stdout(chalk.blue(`[UNMOUNTED]: ${input}`));
}

function stdoutUnmountForce(input) {
  stdoutNewline(1);
  stdout(chalk.bgBlue(`[SSHFS PROCESS KILLED]: ${input}`));
}

function stdoutNewline(number = 1) {
  let newlines = "";
  for (let i = 0; i < number; i++) {
    newlines += os.EOL;
  }
  stdout(newlines);
}
