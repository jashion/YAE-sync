var dbHelper = require(FRAMEWORKPATH + "/utils/dbHelper");
var oss = require(FRAMEWORKPATH + "/utils/ossClient");
var libsync = require("./libsync");
var fs = require("fs");
var async = require("async");
var md5 = require("MD5");

exports.checkDeviceId = checkDeviceId;
exports.checkChunk = checkChunk;
exports.downloadChunk = downloadChunk;
exports.uploadDeltaOrRdb = uploadDeltaOrRdb;
exports.downloadRdb = downloadRdb;
exports.queryLatestBackupRecord = queryLatestBackupRecord;

function checkDeviceId(req, res, next){

    var deviceId = req.headers["x-deviceid"];
    var enterpriseId = req.headers["x-enterpriseid"];

    var sql = "select count(1) as count" +
        " from planx_graph.tb_userlogincounts a, planx_graph.tb_enterprise b" +
        " where a.username = b.admin_account and b.id = :enterprise_id and a.deviceId = :device_id";

    dbHelper.execSql(sql, {enterprise_id: enterpriseId, device_id: deviceId}, function(err, result){

        if(err){
            console.log(err);
            next(err);
            return;
        }

        // 设备ID不一致，这可能是解锁设备造成的
        if(result[0].count === 0){
            console.log("备份接口异常调用，没有找到登陆设备，或登陆设备不一致");
            doResponse(req, res, {code:1, error:{errorCode: 400, errorMessage: "没有找到登陆设备，或登陆设备不一致"}});
            return;
        }

        doResponse(req, res, {message: "ok"});
    });
}

function checkChunk(req, res, next){

    var enterpriseId = req.headers["x-enterpriseid"];

    dbHelper.queryData("new_backup_history", {"enterprise_id": enterpriseId}, function(err, result){

        if(err){
            console.log(err);
            next(err);
            return;
        }

        if(result.length > 0){
            doResponse(req, res, {flag: 1});
        }else{
            doResponse(req, res, {flag: 0});
        }
    });
}

function downloadChunk(req, res, next){

    var enterpriseId = req.headers["x-enterpriseid"];

    _fetchLatestRdbFromOss(enterpriseId, function(err, localRdbPath){

        if(err){
            console.log(err);
            next(err);
            return;
        }

        var chunkPath = localRdbPath.replace("oss_cache", "chunk_cache").replace("rdb", "chunk");

        libsync.file_chunk(localRdbPath, chunkPath, 0, function (err, flag) {

            _removeFile(localRdbPath, function(){

                if(err){
                    console.log("调用libsync库失败");
                    console.log(err);
                    next(err);
                    return;
                }

                if(flag === -1){
                    console.log({errorMessage: "调用file_chunk失败"});
                    next({errorMessage: "调用file_chunk失败"});
                    return;
                }

                res.download(chunkPath, "current.chunk", function(err){

                    if(err){
                        console.log("下载chunk文件失败");
                        console.log(err);
                    }

                    _removeFile(chunkPath);
                });
            });
        });
    });
}

function uploadDeltaOrRdb(req, res, next){

    var deviceId = req.headers["x-deviceid"];
    var enterpriseId = req.headers["x-enterpriseid"];
    var backupType = req.headers["x-backuptype"];// full or chunk
    var md5_before_delta = req.headers["x-deltamd5"] || "";// 客户端rdb文件的md5

    req.form.on("end", function(){

        var now = new Date().getTime();

        var tmp_path = req.files.file.path;// 上传文件缓存路径
        var uploadPath = global.appdir + "data/upload_cache/" + req.files.file.name;// 上传的rdb或delta

        fs.rename(tmp_path, uploadPath, function(err){

            if(err){
                console.log("移动文件失败，上传文件未保存成功: " + uploadPath);
                next(err);
                return;
            }

            if(backupType === "full"){
                _handleRdbFile();
            }else{
                _handleDeltaFile();
            }
        });

        function _handleRdbFile(){

            var ossFileName = now + "_" + req.files.file.name;

            _putOssAndRecord(ossFileName, uploadPath, function(err){

                if(err){
                    next(err);
                    return;
                }

                doResponse(req, res, {message: "ok"});
            });
        }

        function _handleDeltaFile(){

            _fetchLatestRdbFromOss(enterpriseId, function(err, localRdbPath){

                if(err){
                    console.log(err);
                    _removeFile(uploadPath, function(){
                        next(err);
                    });
                    return;
                }

                libsync.file_sync(localRdbPath, uploadPath, function(err, flag){

                    if(err){
                        console.log("调用libsync库失败");
                        console.log(err);
                        _removeFile(uploadPath, function(){
                            next(err);
                        });
                        return;
                    }

                    if(flag === -1){
                        console.log({errorMessage: "调用file_sync失败"});
                        _removeFile(uploadPath, function(){
                            next({errorMessage: "调用file_sync失败"});
                        });
                        return;
                    }

                    fs.readFile(localRdbPath, function(err, data){

                        var md5_after_sync = md5(data);

                        if(md5_after_sync !== md5_before_delta){
                            console.log("sync后的rdb与客户端本地rdb的MD5不一致，rdb文件可能已损坏！");
                            _removeFile(localRdbPath, function(){
                                next({errorMessage: "MD5校验失败，rdb文件可能已损坏！"});
                            });
                            return;
                        }

                        var nameExt = req.files.file.name.replace("delta", "rdb");
                        var ossFileName = now + "_" + nameExt;

                        _putOssAndRecord(ossFileName, localRdbPath, function(err){

                            if(err){
                                next(err);
                                return;
                            }

                            doResponse(req, res, {message: "ok"});
                        });
                    });
                });
            });
        }

        function _putOssAndRecord(ossFileName, localFilePath, callback){

            oss.putNewBackupObjectToOss(ossFileName, localFilePath, function(err){

                _removeFile(localFilePath, function(){

                    if(err){
                        console.log("上传文件到OSS失败");
                        console.log(err);
                        callback(err);
                        return;
                    }

                    var model = {
                        enterprise_id: enterpriseId,
                        device_id: deviceId,
                        oss_path: ossFileName,
                        upload_date: now,
                        merge_done: 0
                    };

                    dbHelper.addData("new_backup_history", model, function(err){

                        if(err){
                            console.log("备份记录写入数据库失败");
                            console.log(err);
                            callback(err);
                            return;
                        }

                        callback(null);
                    });
                });
            });
        }
    });
}

function downloadRdb(req, res, next){

    var enterpriseId = req.headers["x-enterpriseid"];

    _fetchLatestRdbFromOss(enterpriseId, function(err, localRdbPath){

        if(err){
            console.log(err);
            next(err);
            return;
        }

        res.download(localRdbPath, "latest.rdb", function(err){

            if(err){
                console.log("下载rdb文件失败");
                console.log(err);
            }

            _removeFile(localRdbPath);
        });
    });
}

function queryLatestBackupRecord(req, res, next){

    var enterpriseId = req.headers["x-enterpriseid"];

    var sql = "select id, enterprise_id, upload_date as lastBackup_date" +
        " from planx_graph.new_backup_history" +
        " where enterprise_id = :enterprise_id order by upload_date desc limit 0, 1;";

    dbHelper.execSql(sql, {enterprise_id: enterpriseId}, function(err, results){

        if(err){
            console.log(err);
            next(err);
            return;
        }

        if(results.length === 0){
            doResponse(req, res, {});
        }else{
            doResponse(req, res, results[0]);
        }
    });
}

function _fetchLatestRdbFromOss(enterpriseId, callback){

    var sql = "select * from planx_graph.new_backup_history where enterprise_id = :enterprise_id order by id desc limit 0, 1";

    dbHelper.execSql(sql, {enterprise_id: enterpriseId}, function(err, result){

        if(err){
            console.log("查询oss路径失败");
            callback(err);
            return;
        }

        if(result.length === 0){
            callback({errorMessage: "找不到rdb文件"});
            return;
        }

        var ossPath = result[0].oss_path;
        var localRdbPath = global.appdir + "data/oss_cache/" + ossPath;

        oss.getObject("new-backup", ossPath, localRdbPath, function(err) {

            if(err){
                console.log("从OSS获取文件失败");
                callback(err);
                return;
            }

            callback(null, localRdbPath);
        });
    });
}

function _removeFile(filePath, callback){

    fs.unlink(filePath, function(err){

        if(err){
            console.log("删除文件失败: " + filePath);
        }

        if(callback){
            callback();
        }
    });
}