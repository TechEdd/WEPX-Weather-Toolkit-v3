<?php
	require_once 'sanitizeFilename.php';
	include_once 'getLastRun.php';

	function getDefaultVariable($model, $run, $variable){
		// Define the directory to search
		$directory = "./downloads/$model/$run/";

		// Define the directory to search
		$directory = __DIR__ . "/../downloads/$model/$run/";	

		// Check if the directory exists
		if (!is_dir($directory)) {
			die("Directory not found: $directory");
		};
		
		$files = scandir($directory);
		
		$match = null;

		// Loop through files to find the first match
		foreach ($files as $file) {
			if (preg_match("/\." . preg_quote($variable, '/') . "\.([^.]*)\./", $file, $matches)) {
				$match = $matches[1]; // Extract the string after $variable
				break; // Stop after the first match
			}
		}

		// If a match is found, echo the formatted string
		if ($match !== null) {
			return $match;
		} else {
			return "No matching file found.";
		}
	} 

	// If this file is accessed directly (not included), output the result
	if (basename(__FILE__) == basename($_SERVER["SCRIPT_FILENAME"])) {
		$model = sanitizeFilename($_GET['model'] ?? 'HRRR');
		$run = sanitizeFilename($_GET['run'] ?? getLastRun($model));
		$variable = sanitizeFilename($_GET['variable'] ?? 'CAPE');

		echo getDefaultVariable($model, $run, $variable);
	}


?>