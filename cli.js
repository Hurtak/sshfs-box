#!/usr/bin/env node

/*
  TODO
    stdout helper functions?
    newline before each command compared to after?
    async mounting?
    rename?
    docs
    gifs
    twitter
*/

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const meow = require("meow");
const chalk = require("chalk");
const execa = require("execa");
const indentString = require("indent-string");
const inquirer = require("inquirer");

// Global variables

const configDir = path.join(os.homedir(), "/.config/");
const configPath = path.join(configDir, "sshfs-box.json");

// CLI

const cli = meow(
  `
  Small CLI tool to mount/unmount directories on remote servers with sshfs.

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
    process.stdout.write(
      `Can't open config on ${configPath}, creating new config`
    );
    const config = await promptEditConfig();
    await promptSshfs(config);
    return;
  }

  if (cli.flags.config) {
    const config = await promptEditConfig(configString);
    await promptSshfs(config);
  } else {
    const [configValid] = validateConfigString(configString);
    if (configValid) {
      await promptSshfs(JSON.parse(configString));
    } else {
      process.stdout.write(
        `${configPath} does not contain valid config, please fix it`
      );
      const config = await promptEditConfig(configString);
      await promptSshfs(config);
    }
  }
}

main(); // Start the app.

// Prompt functions.

async function promptEditConfig(defaultConfigOverride) {
  const defaultConfig = JSON.stringify(
    {
      urls: ["user@host1:", "user@host2:/home/user", "user@host2:/www"],
      folder: path.join(os.homedir(), "/remote"),
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
    process.stdout.write(
      chalk.bgRed(
        `! ERROR:     Error while getting sshfs mounted folders, exiting`
      )
    );
    process.stdout.write(os.EOL);
    process.stdout.write(
      indentString(removeTrailingNewline(err.toString()), 4)
    );
    process.stdout.write(os.EOL);

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

  const response = await inquirer.prompt({
    type: "checkbox",
    message: "SSHFS mount/unmount dirs",
    name: "urls",
    choices: data,
  });
  const selectedUrls = response.urls;

  process.stdout.write(os.EOL);

  // mount selected items that are not already mounted
  const mountItems = selectedUrls
    .map(url => data.find(item => item.name === url))
    .filter(item => !isMountedWithMount(mounted, item.remote, item.local));

  for (const data of mountItems) {
    try {
      await execa("mkdir", ["-p", data.local]);
    } catch (err) {
      process.stdout.write(chalk.bgRed(`! ERROR:     ${data.remote}`));
      process.stdout.write(os.EOL);
      process.stdout.write(
        indentString(removeTrailingNewline(err.toString()), 4)
      );
      process.stdout.write(os.EOL);
      continue;
    }

    try {
      await execa("sshfs", [data.remote, data.local]);
    } catch (err) {
      process.stdout.write(chalk.bgRed(`! ERROR:     ${data.remote}`));
      process.stdout.write(os.EOL);
      process.stdout.write(
        indentString(removeTrailingNewline(err.toString()), 4)
      );
      process.stdout.write(os.EOL);
      continue;
    }

    process.stdout.write(chalk.green(`+ Mounted:   ${data.remote}`));
    process.stdout.write(os.EOL);
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

    const answer = await inquirer.prompt({
      type: "checkbox",
      message: "There were poblems with unmomunting, force unmount?",
      name: "urls",
      choices: forceUnmountChoices,
    });
    const forceUnmountUrls = answer.urls;

    const forceUnmountItems = forceUnmountUrls.map(url =>
      data.find(item => item.name === url)
    );

    let response = null;
    try {
      response = await execa("ps", ["-x"]);
    } catch (err) {
      process.stdout.write(chalk.bgRed(`! ERROR:     Unable to run ps -x`));
      process.stdout.write(os.EOL);
      process.stdout.write(
        indentString(removeTrailingNewline(err.toString()), 4)
      );
      process.stdout.write(os.EOL);
      return;
    }

    const processes = response.stdout.split(os.EOL);
    if (!processes) {
      process.stdout.write(
        chalk.bgRed(`! ERROR:     Unable to find any sshfs processes with`)
      );
      process.stdout.write(os.EOL);
      return;
    }

    for (const item of forceUnmountItems) {
      const processRow = processes.find(row =>
        row.includes(`sshfs ${item.remote} ${item.local}`)
      );
      if (!processRow) {
        process.stdout.write(
          chalk.bgRed(`! ERROR:     ${item.remote} Unable to sshfs processes`)
        );
        process.stdout.write(os.EOL);
        continue;
      }
      const pidMatches = processRow.match(/^\s*\d+/);
      const pid = pidMatches.length > 0 ? pidMatches[0] : null;

      if (!pid) {
        process.stdout.write(
          chalk.bgRed(
            `! ERROR:     ${item.remote} Unable to parse sshfs processes id`
          )
        );
        process.stdout.write(os.EOL);
        continue;
      }

      let processKilled = false;
      try {
        await execa("kill", ["-9", pid]);
        processKilled = true;
      } catch (err) {
        process.stdout.write(
          chalk.bgRed(
            `! ERROR:     ${item.remote} Unable to kill sshfs process`
          )
        );
        process.stdout.write(os.EOL);
        process.stdout.write(
          indentString(removeTrailingNewline(err.toString()), 4)
        );
        process.stdout.write(os.EOL);
        continue;
      }
      if (processKilled) {
        process.stdout.write(
          chalk.bgBlue(`! FORCE UNMOUNT: ${item.remote} process killed`)
        );
        process.stdout.write(os.EOL);
      }

      await unmount(item);
    }
  }
}

function validateConfigString(configString) {
  let config;
  try {
    config = JSON.parse(configString);
  } catch (e) {
    return [false, "Error parsing JSON"];
  }

  if (!config.urls) {
    return [false, `"urls" field is missing or empty`];
  } else if (!Array.isArray(config.urls)) {
    return [false, `"urls" filed is not an array`];
  } else if (config.urls.some(item => typeof item !== "string")) {
    return [false, `all fields in "urls" filed need to be string`];
  } else if (!config.folder) {
    return [false, `"folder" field is missing or empy`];
  } else if (typeof config.folder !== "string") {
    return [false, `"folder" field must be string`];
  }

  return [true, null];
}

function removeTrailingNewline(str) {
  if (str.endsWith(os.EOL)) {
    return str.slice(0, str.length - os.EOL.length);
  }
  return str;
}

function isMountedWithMount(mountRows, remote, local) {
  return mountRows.some(mount => mount.startsWith(remote + " on " + local));
}

async function unmount(data) {
  try {
    await execa("fusermount", ["-u", data.local]);
  } catch (err) {
    process.stdout.write(chalk.bgRed(`! ERROR:     ${data.remote}`));
    process.stdout.write(os.EOL);
    process.stdout.write(
      indentString(removeTrailingNewline(err.toString()), 4)
    );
    process.stdout.write(os.EOL);

    return false;
  }

  process.stdout.write(chalk.blue(`- Unmounted: ${data.remote}`));
  process.stdout.write(os.EOL);

  return true;
}
