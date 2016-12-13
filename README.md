# SSHFS box

- small CLI tool to simply mount/unmount remote sshfs directories

## Prerequisites

- node.js >= 6
- npm
- operating system
    - Linux - tested works
    - MacOs - untested, should work

## Install

- `npm install --global sshfs-box`

## Usage

- create `~/.config/sshfs-box.json` file
- add configuration
    - `urls` array of strings of remote locations where sshfs-box will try to connect
    - `folder` string of local folder where remote locations will be mounted (does not need to exist)

### Example configuration

```json
{
    "urls": [
        "user@host1:dir",
        "user@host2:dir"
    ],
    "folder": "/home/username/remote"
}
```

## Run

- `sshfs-box` starts the interface for mounting/unmounting

## Screenshots

- TODO

## TODO

- add `--help` parameter
- add `--config -c` parameter which would open editor interactive mode to edit sshfs-box.json
- cleanup package.json
- config validation
- gifs
- docs

