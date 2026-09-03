declare const __SPEECHNOTE_DEVELOPMENT__: boolean;
declare const __SPEECHNOTE_TEST__: boolean;

export const isDevelopmentBuild =
    typeof __SPEECHNOTE_DEVELOPMENT__ !== 'undefined' && __SPEECHNOTE_DEVELOPMENT__;
export const isTestBuild = typeof __SPEECHNOTE_TEST__ !== 'undefined' && __SPEECHNOTE_TEST__;
