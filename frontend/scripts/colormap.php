<?php
$variable = $_GET['variable'];
	if ($variable) {
		// Sanitize the variable to prevent directory traversal attacks
		$safeVariable = basename($variable);

		// Construct the file path
		$filePath = "colormaps/" . $safeVariable . ".txt";

		// Check if the file exists
		if (file_exists($filePath)) {
			// Read and echo the file contents
			include($filePath);
		} else {
			// Handle the case where the file does not exist
			echo "Error: File not found.";
		}
	} else {
		// Handle the case where 'variable' is not provided
		echo "Error: No variable provided.";
	}
	
	?>