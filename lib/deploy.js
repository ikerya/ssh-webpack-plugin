const async = require('async');
const ssh = require('ssh2');
const fs = require('fs');
const extend = require('extend');
const childProcessExec = require('child_process').exec;
const SftpClient = require('ssh2-sftp-client');
const path = require('path');

const sftp = new SftpClient();

function getSftpOptions(options) {
    const sftpOptions = {
        port: options.port,
        host: options.host,
        username: options.username,
        readyTimeout: options.readyTimeout,
    };
    if (options.privateKey) {
        sftpOptions.privateKey = options.privateKey;
        if (options.passphrase) sftpOptions.passphrase = options.passphrase;
    } else if (options.password) {
        sftpOptions.password = options.password;
    } else {
        throw new Error('Password or privateKey is required.');
    }
    return sftpOptions;
}

function execDeploy(options, connection) {
    const startTime = new Date();

    const task = {
        zipLocal(callback) {
            if (!options.zip) return callback();
            childProcessExec('tar --version', function (error, stdout) {
                if (!error) {
                    const isGnuTar = stdout.includes('GNU tar');
                    let command = 'tar -czvf ./deploy.tgz';
                    if (options.exclude.length) {
                        options.exclude.forEach((exclusion) => {
                            command += ` --exclude=${exclusion}`;
                        });
                    }
                    if (isGnuTar) {
                        command += ` --exclude=deploy.tgz --ignore-failed-read --directory=${options.from} .`;
                    } else {
                        command += ` --directory=${options.from} .`;
                    }
                    console.info('Zipping Deploy Command:'.yellow);
                    console.info(' > ' + command);
                    execLocal(command, options.debug, callback);
                }
            });
        },
        beforeDeploy(callback) {
            execRemote('before', callback);
        },
        cleanRemoteOld(callback) {
            if (!options.to || options.cover === true) return callback();
            const command = `cd ${options.to} && rm -fr *`;
            console.info('Clean Remote OldFiles: '.yellow);
            console.info(' > ' + command);
            execCommand(command, options.debug, callback);
        },
        async uploadDeploy(callback) {
            const sftp = new SftpClient();
            const localPath = options.from; // Example: './dist'
            const remotePath = options.to; // Example: '/remote/path'
        
            try {
                // Verify local path exists
                if (!fs.existsSync(localPath)) {
                    throw new Error(`Local path does not exist: ${localPath}`);
                }
        
                // Connect to the SFTP server
                await sftp.connect({
                    host: options.host,
                    port: options.port || 22,
                    username: options.username,
                    password: options.password,
                });
        
                console.log('Connected to SFTP server.');
        
                // Check if localPath is a directory or file
                const stats = fs.lstatSync(localPath);
        
                if (stats.isDirectory()) {
                    // Recursively upload directory
                    console.log(`Uploading directory: ${localPath} to ${remotePath}`);
                    await sftp.uploadDir(localPath, remotePath);
                } else if (stats.isFile()) {
                    // Upload a single file
                    console.log(`Uploading file: ${localPath} to ${remotePath}`);
                    await sftp.put(localPath, path.join(remotePath, path.basename(localPath)));
                } else {
                    throw new Error(`Unsupported file type: ${localPath}`);
                }
        
                console.log('Upload completed successfully.');
                callback?.(null); // Indicate success
            } catch (err) {
                console.error(`Upload failed: ${err.message}`);
                callback?.(err); // Pass the error to the callback
            } finally {
                // Always close the SFTP connection
                await sftp.end();
                console.log('SFTP connection closed.');
            }
        },
        unzipRemote(callback) {
            if (!options.zip) return callback();
            const goToCurrent = `cd ${options.to}`;
            const unTar = 'tar -xzvf deploy.tgz';
            const cleanDeploy = `rm ${path.posix.join(options.to, 'deploy.tgz')}`;
            const command = [goToCurrent, unTar, cleanDeploy].join(' && ');
            console.info('Unzip Zipfile: '.yellow);
            console.info(' > ' + command);
            execCommand(command, options.debug, callback);
        },
        afterDeploy(callback) {
            execRemote('after', callback);
        },
        deleteLocalZip(callback) {
            if (!options.zip) return callback();
            const command = process.platform === 'win32' ? 'del deploy.tgz' : 'rm deploy.tgz';
            console.info('Local cleanup: '.yellow);
            console.info(' > ' + command);
            execLocal(command, options.debug, callback);
        },
        closeConnection(callback) {
            connection.end();
            callback();
        },
    };

    function execRemote(type, callback) {
        if (typeof options[type] === 'undefined') return callback();
        const command = options[type];
        console.info(
            `${type.replace(/^./, (i) => i.toUpperCase())} Deploy Running Remote Commands: `.yellow
        );
        if (Array.isArray(command)) {
            async.eachSeries(command, (cmd, cb) => {
                console.info(' > ' + cmd);
                execCommand(cmd, options.debug, cb);
            }, callback);
        } else {
            console.info(' > ' + command);
            execCommand(command, options.debug, callback);
        }
    }

    function execCommand(cmd, debug, next) {
        connection.exec(cmd, (err, stream) => {
            if (err) {
                console.error(err);
                console.error('Error Deploy: '.red + 'closing connection.');
                task.closeConnection();
                return;
            }
            stream.on('data', (data) => {
                debug && console.info(data.toString());
            });
            stream.on('end', () => next());
        });
    }

    function execLocal(cmd, debug, next) {
        const execOptions = { maxBuffer: options.max_buffer };
        childProcessExec(cmd, execOptions, (err, stdout, stderr) => {
            if (debug) {
                console.info('stdout: ' + stdout);
                console.info('stderr: ' + stderr);
            }
            if (err) {
                console.error('Exec Error: '.red + err);
                console.error('Error deploying. Closing connection.'.red);
            } else {
                next();
            }
        });
    }

    async.series(
        [
            task.zipLocal,
            task.beforeDeploy,
            task.cleanRemoteOld,
            task.uploadDeploy,
            task.unzipRemote,
            task.afterDeploy,
            task.deleteLocalZip,
            task.closeConnection,
        ],
        () => {
            console.info('Deployed: '.blue + (new Date() - startTime) + 'ms');
        }
    );
}

exports.deploy = function (options) {
    const Client = ssh.Client;
    const connection = new Client();
    options = extend(
        {},
        {
            zip: true,
            port: 22,
            from: 'build',
            debug: false,
            max_buffer: 200 * 1024,
            readyTimeout: 20000,
            cover: true,
            exclude: [],
        },
        options
    );

    connection
        .on('connect', () => {
            console.info('[ Start Deploy ]'.green);
            console.info('Connecting: '.yellow + options.host);
        })
        .on('ready', () => {
            console.info('Connected: '.yellow + options.host);
            execDeploy(options, connection);
        })
        .on('error', (err) => {
            console.error('Error: '.red + options.host);
            console.error(err);
            if (err) throw err;
        })
        .on('close', () => {
            console.info('Closed: '.yellow + options.host);
            return true;
        })
        .connect(options);
};