<?php
declare(strict_types=1);

define('AVIAN_BIRDNET_API_LIBRARY_ONLY', true);
require dirname(__DIR__) . '/avian/api/birdnet-api.php';

$checks = 0;
function check(bool $condition, string $message): void {
    global $checks;
    $checks++;
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}

$path = tempnam(sys_get_temp_dir(), 'avian-site-name-');
check(is_string($path), 'temporary config created');

file_put_contents($path, "GEMINI_API_KEY=private-token\nSITE_NAME=Garden Birds\n");
check(publicSiteName($path) === 'Garden Birds', 'plain canonical name is public');

file_put_contents($path, "  # ignored\nexport SITE_NAME=Old\nSITE_NAME=\"Teddy's Birds\" # canonical\n");
check(publicSiteName($path) === "Teddy's Birds", 'quoted last assignment and inline comment are parsed');

file_put_contents($path, "SITE_NAME=Safe Name\nSITE_NAME=\$(unsafe)\nEBIRD_API_KEY=private-token\n");
check(publicSiteName($path) === 'Safe Name', 'invalid later values cannot replace a safe canonical name');

file_put_contents($path, 'SITE_NAME=' . str_repeat('A', 61) . "\n");
check(publicSiteName($path) === 'BirdNET-Pi', 'overlong names use the public default');

unlink($path);
check(publicSiteName($path) === 'BirdNET-Pi', 'missing config uses the public default');

echo "site name api tests passed ({$checks} checks)\n";
