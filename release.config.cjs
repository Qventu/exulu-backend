module.exports = {
    branches: [
        'main', 
        { name: 'next', prerelease: true },
        { name: 'hotfix/*', rangeStrategy: 'always'} // any branch like hotfix/1.19.1 will trigger a release
    ],
    plugins: [
        '@semantic-release/commit-analyzer',
        '@semantic-release/release-notes-generator',
        '@semantic-release/changelog',
        '@semantic-release/npm',
        [
            '@semantic-release/github',
            {
                assets: []
            }
        ]
    ],
}
