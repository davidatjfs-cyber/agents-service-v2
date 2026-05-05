#!/bin/bash
# 由其它脚本 source：注册 EXIT 时非 0 则告警
pg_pitr_register_exit_alert() {
  local name="$1"
  _pg_pitr_on_exit() {
    local c=$?
    (( c == 0 )) && return 0
    if [[ -x /opt/pg_pitr/scripts/pg-pitr-alert.sh ]]; then
      /opt/pg_pitr/scripts/pg-pitr-alert.sh send "${name}: 脚本异常退出 exit=${c}"
    fi
  }
  trap _pg_pitr_on_exit EXIT
}
