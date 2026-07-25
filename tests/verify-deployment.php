<?php declare(strict_types=1);

$source = realpath(__DIR__ . '/../src');
$target = realpath(__DIR__ . '/../../../assets/modularchatbot');

if($source === false || $target === false) {
	fwrite(STDERR, "Source or deployment directory is missing.\n");
	exit(1);
}

$collect = static function(string $directory): array {
	$files = [];
	$iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(
		$directory,
		FilesystemIterator::SKIP_DOTS
	));

	foreach($iterator as $file) {
		if(!$file->isFile()) continue;
		$relative = substr($file->getPathname(), strlen($directory) + 1);
		$files[$relative] = hash_file('sha256', $file->getPathname());
	}

	ksort($files);
	return $files;
};

if($collect($source) !== $collect($target)) {
	fwrite(STDERR, "The deployed ModularChatbot assets differ from the repository source.\n");
	exit(1);
}

echo "ModularChatbot deployment verified.\n";
