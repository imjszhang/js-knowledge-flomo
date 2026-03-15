/**
 * Formatters — CLI 输出格式化
 *
 * JSON 结果 → stdout，日志 → stderr
 */

export function toJson(data) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function toStderr(msg) {
    process.stderr.write(msg + '\n');
}
