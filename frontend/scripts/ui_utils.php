<?php
/**
 * Parses ui.yaml and returns configuration array for a specific variable and level.
 * @param string $variable The key for variables_metadata (e.g., "TMP")
 * @param string $level    The key for levels_metadata (e.g., "0-EATM")
 * @return array
 */
function getUiConfig($variable, $level) {
    // Adjust path as needed depending on where this script is included from.
    // We use __DIR__ to find the parent config folder relative to scripts/
    $filePath = __DIR__ . '/../config/ui.yaml';
    
    if (!file_exists($filePath)) {
        return [];
    }

    // Parse the YAML data
    // Ensure the yaml extension is installed/enabled in php.ini
    if (!function_exists('yaml_parse_file')) {
        return [];
    }
    
    $data = yaml_parse_file($filePath);

    // Extract Variable Metadata (with fallbacks)
    $varData = $data['variables_metadata'][$variable] ?? [];
    // Extract Level Metadata
    $lvlData = $data['levels_metadata'][$level] ?? [];

    return [
        'var_name_en'      => $varData['name_en'] ?? $variable,
        'var_name_fr'      => $varData['name_fr'] ?? $variable,
        'available_units'  => $varData['available_units'] ?? [],
        'grib_unit'        => $varData['grib_unit'] ?? '',
        'default_unit'     => $varData['default_unit'] ?? '',
        'default_colormap' => $varData['default_colormap'] ?? 'default',
        'level_name_en'    => $lvlData['name_en'] ?? $level,
        'level_name_fr'    => $lvlData['name_fr'] ?? $level
    ];
}
?>