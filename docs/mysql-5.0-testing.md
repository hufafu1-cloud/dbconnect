# MySQL 5.0 compatibility regression

Verified locally with Oracle's Linux MySQL 5.0.22-standard binary in an
Ubuntu 22.04 Docker container, and MySQL 8.0.46. This is protocol testing,
not a substitute for the Windows 7 / 5.0.22-community-nt deployment test.

Official archive:
https://cdn.mysql.com/archives/mysql-5.0/mysql-standard-5.0.22-linux-x86_64-glibc23.tar.gz

Downloaded archive SHA256:
`224341321197367fb7eb94f6797d5f12435b670dd2ed764aa12fd22c1cb24f58`

Local container: `dbpanda-mysql5022-test`, bound only to `127.0.0.1:3308`.
Database `dbpanda_test`, user `dbpanda`, disposable test password
`DbPanda_Test_2026`. The existing MySQL 8 container uses port 3307.

The 5.0 binary is extracted to `/opt/mysql`; initialization uses
`scripts/mysql_install_db --user=root --basedir=/opt/mysql --datadir=/opt/mysql/data`.
Ubuntu package `libncurses5` is required by the old mysql CLI.
The container stays alive with `sleep infinity`; after restarting it, start
the database process with:

```powershell
docker start dbpanda-mysql5022-test
docker exec -d dbpanda-mysql5022-test /opt/mysql/bin/mysqld --user=root --basedir=/opt/mysql --datadir=/opt/mysql/data --bind-address=0.0.0.0 --port=3306 --socket=/tmp/mysql.sock
```

Run the opt-in regression only against these disposable databases:

```powershell
$env:MYSQL_TEST_PORT='3308'
node scripts/test-mysql-legacy-live.js
$env:MYSQL_TEST_PORT='3307'
node scripts/test-mysql-legacy-live.js
```

Before the fix, initial authentication succeeded but connection IDs changed
after release: unsupported COM_RESET_CONNECTION discarded every connection.
The original ETIMEDOUT was not reproduced locally.
The fix discovers charset support using a UTF-8 bootstrap connection, then
uses COM_CHANGE_USER for MySQL versions before 5.7.3. SET NAMES is reapplied
after that command because 5.0.22 resets charset variables to server defaults.
Modern MySQL keeps utf8mb4 and COM_RESET_CONNECTION.

The regression also passed with the Win7 profile's locked mysql2 3.24.5
installed in an isolated directory; no production dependency lock was changed.

Tests cover metadata, repeated concurrent requests, connection reuse, Chinese
text, clearing session variables and temporary tables, and restoring autocommit.
