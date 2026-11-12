#include <jni.h>
#include <string>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include <cstring>

#include "libnode/include/node/node.h"

static JavaVM* g_jvm = nullptr;
static jobject g_logCallback = nullptr;
static jmethodID g_onLogMethod = nullptr;

static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;
static const char *ADBTAG = "JiMaoNodeServer";

static void send_log_to_java(const char* line, bool is_error) {
    if (!g_jvm || !g_logCallback || !g_onLogMethod) return;
    JNIEnv* env = nullptr;
    bool attached = false;
    if (g_jvm->GetEnv((void**)&env, JNI_VERSION_1_6) != JNI_OK) {
        if (g_jvm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
            attached = true;
        } else {
            return;
        }
    }
    jstring jmsg = env->NewStringUTF(line);
    env->CallVoidMethod(g_logCallback, g_onLogMethod, jmsg, (jboolean)is_error);
    env->DeleteLocalRef(jmsg);
    if (attached) {
        g_jvm->DetachCurrentThread();
    }
}

static bool is_noisy_log(const char* buf) {
    if (!buf) return false;
    return strstr(buf, "shared_image") != nullptr ||
           strstr(buf, "SharedImage") != nullptr ||
           strstr(buf, "chromium") != nullptr ||
           strstr(buf, "egl_") != nullptr ||
           strstr(buf, "GL_") != nullptr;
}

static void *thread_stderr_func(void*) {
    ssize_t redirect_size;
    char buf[2048];
    while((redirect_size = read(pipe_stderr[0], buf, sizeof(buf) - 1)) > 0) {
        if(buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        if (is_noisy_log(buf)) continue;
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
        send_log_to_java(buf, true);
    }
    return nullptr;
}

static void *thread_stdout_func(void*) {
    ssize_t redirect_size;
    char buf[2048];
    while((redirect_size = read(pipe_stdout[0], buf, sizeof(buf) - 1)) > 0) {
        if(buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        if (is_noisy_log(buf)) continue;
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
        send_log_to_java(buf, false);
    }
    return nullptr;
}

static int start_redirecting_stdout_stderr() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    if(pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr) == -1) return -1;
    pthread_detach(thread_stdout);

    if(pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr) == -1) return -1;
    pthread_detach(thread_stderr);

    return 0;
}

JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {
    g_jvm = vm;
    return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL
Java_com_aigame_server_NodeServerService_registerLogCallback(
        JNIEnv *env,
        jobject /* this */,
        jobject callback) {
    if (g_logCallback) {
        env->DeleteGlobalRef(g_logCallback);
        g_logCallback = nullptr;
    }
    if (callback) {
        g_logCallback = env->NewGlobalRef(callback);
        jclass cls = env->GetObjectClass(callback);
        g_onLogMethod = env->GetMethodID(cls, "onLog", "(Ljava/lang/String;Z)V");
    }
}

extern "C" JNIEXPORT jint JNICALL
Java_com_aigame_server_NodeServerService_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments,
        jstring modulesPath,
        jstring lanIp) {

    if (modulesPath != nullptr) {
        const char* path_str = env->GetStringUTFChars(modulesPath, nullptr);
        setenv("NODE_PATH", path_str, 1);
        env->ReleaseStringUTFChars(modulesPath, path_str);
    }

    if (lanIp != nullptr) {
        const char* ip_str = env->GetStringUTFChars(lanIp, nullptr);
        setenv("LAN_IP", ip_str, 1);
        env->ReleaseStringUTFChars(lanIp, ip_str);
    }

    jsize argument_count = env->GetArrayLength(arguments);
    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        auto str = (jstring)env->GetObjectArrayElement(arguments, i);
        c_arguments_size += strlen(env->GetStringUTFChars(str, nullptr)) + 1;
        env->DeleteLocalRef(str);
    }

    char* args_buffer = (char*)calloc(c_arguments_size, sizeof(char));
    char** argv = (char**)calloc(argument_count, sizeof(char*));
    char* current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        auto str = (jstring)env->GetObjectArrayElement(arguments, i);
        const char* current_argument = env->GetStringUTFChars(str, nullptr);
        size_t len = strlen(current_argument);
        strncpy(current_args_position, current_argument, len);
        argv[i] = current_args_position;
        current_args_position += len + 1;
        env->ReleaseStringUTFChars(str, current_argument);
        env->DeleteLocalRef(str);
    }

    start_redirecting_stdout_stderr();

    int exit_code = node::Start(argument_count, argv);

    free(args_buffer);
    free(argv);

    return jint(exit_code);
}
