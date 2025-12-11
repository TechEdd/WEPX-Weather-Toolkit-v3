<?php
if(!function_exists("sanitizeFilename")) {
	function sanitizeFilename($input) {
		// Remove any directory traversal attempts or file paths
		$input = basename($input);
		// Optionally, ensure the input contains only safe characters
		return preg_replace('/[^a-zA-Z0-9_-]/', '', $input);
	}
};
?>