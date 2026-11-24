<?php
declare(strict_types=1);

// Parse one literal BirdNET-Pi config assignment, without evaluating shell.
function avian_station_config_literal(string $raw): ?string {
    if (strlen($raw) > 1024) return null;
    $raw = trim($raw);
    if ($raw === '') return '';
    $first = $raw[0];
    if ($first === "'") {
        $close = strpos($raw, "'", 1);
        if ($close === false || preg_match('/\A\s*(?:#.*)?\z/D', substr($raw, $close + 1)) !== 1) {
            return null;
        }
        return substr($raw, 1, $close - 1);
    }
    if ($first === '"') {
        $value = '';
        $length = strlen($raw);
        for ($index = 1; $index < $length; $index++) {
            $character = $raw[$index];
            if ($character === '"') {
                return preg_match('/\A\s*(?:#.*)?\z/D', substr($raw, $index + 1)) === 1
                    ? $value
                    : null;
            }
            if ($character === '\\') {
                $index++;
                if ($index >= $length) return null;
                $escaped = $raw[$index];
                $value .= in_array($escaped, ['\\', '"', '$', '`'], true)
                    ? $escaped
                    : '\\' . $escaped;
                continue;
            }
            if ($character === '$' || $character === '`') return null;
            $value .= $character;
        }
        return null;
    }
    if (preg_match('/\A([A-Za-z0-9._+,:@%\/=~-]*)(?:\s+#.*)?\z/D', $raw, $match) !== 1) {
        return null;
    }
    return $match[1];
}
