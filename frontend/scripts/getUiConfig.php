<?php
header('Content-Type: application/json');

require_once 'sanitizeFilename.php';
require_once 'ui_utils.php';

// Get params
$variable = sanitizeFilename($_GET['variable'] ?? 'REFC');
$level = sanitizeFilename($_GET['level'] ?? '0-EATM');

// Use the shared function
$config = getUiConfig($variable, $level);

echo json_encode($config);
?>