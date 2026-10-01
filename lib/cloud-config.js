/* cloud-config.js — generated from main-app/stark/cloud-config.json.
 * Do not edit by hand; run tools/sync_extension_cloud_config.py.
 */
(function (root, factory) {
  'use strict';
  var config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  root.RanobeCloudConfig = config;
})(typeof self !== 'undefined' ? self : this, function () {
  return {
  "protocol": "ranobe-hub-tts-v3",
  "version": 3,
  "baseUrl": "https://huggingface.co/datasets/akir21518/ranobe-audio/resolve/main",
  "storage": {
    "rootFolder": "books",
    "bookFolder": "{book_id}",
    "chaptersFolder": "chapters",
    "chapterFolder": "{chapter_id}",
    "audioFile": "audio.mp3",
    "manifestFile": "manifest.json",
    "bookIndexFile": "index.json"
  },
  "audioHosts": [
    "huggingface.co",
    "cdn-lfs.huggingface.co",
    "cdn-lfs-us-1.hf.co",
    "cas-bridge.xethub.hf.co",
    "transfer.xethub.hf.co"
  ]
};
});
