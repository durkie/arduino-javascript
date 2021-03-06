import translator from './translator';
// import SerialApiWrapper from './serial-api-wrapper';
import commands from './avr109-commands';
import Data from './data';

class Avr109 {
  constructor (serial) {
    this.connection = this.getConnection(serial);
    // Arduino and the board both have a serial obj.
    // This allows an Arduino instance to have multiple boards, each connected to their own serial port.
    // potentially an Arduino instance should not have a serial obj?
    this.serial = serial;
    this.bootloaderBitrate = 1200;
    this.dataBitrate = 57600; // this came from chrome-arduino
    this.flashSize = 28672;
    this.pageSize = 128;
    this.commands = commands;
    this.pages = [];
    this.responseHandler = this.defaultHandler;
    this.listenToDevice();
    this.totalPages = this.flashSize / this.pageSize;
    return this;
  }

  // INTERFACE

  downloadSketch (downloadCallback) {
    this.downloadCallback = downloadCallback;
    let self = this;
    return this.startProgramming().then( function (success) {
      if (success) {
        self.readSketchPages().then( function () {
          console.log('Finished reading sketch pages.');
        });
      }
    });
  }

  uploadSketch (data) {
    let self = this;
    return this.startProgramming().then( function (success) {
      if (success) {
        self.writeSketchPages(data).then( function () {
          console.log('Finished uploading sketch.');
        });
      }
    });
  }

  // PRIVATE

  readDispatcher (readArg) {
    this.responseHandler(readArg);
    return;
  }

  readSketchPages () {
    let self = this;
    return new Promise( function (resolve) {
      self.setAddressTo(0).then( function () {
        self.readPage(0);
      });
      resolve(true);
    });
  }

  writeSketchPages (data) {
    console.log('writing sketch pages');
    let self = this;
    return new Promise( function (resolve) {
      self.setAddressTo(0).then( function () {
        self.writePage(0, data);
        resolve(true);
      });
    });
  }

  // TODO: refactor these to a recurseThroughPages method to
  readPage (pageNum) {
    let board = this;
    if (pageNum === this.totalPages) {
      return true;
    } else {
      let readPage = this.commands.readPage;
      let typeFlash = this.commands.typeFlash;
      let sizeBytes = translator.storeAsTwoBytes(this.pageSize);
      let data = new Data([readPage, sizeBytes[0], sizeBytes[1], typeFlash]);

      board.responseHandler = this.readPageHandler;

      this.serial.send(data).then( function () {
        board.readPage(pageNum + 1);
      });
    }
  }

  writePage (pageNum, dataObj) {
    let board = this;
    if (pageNum === this.totalPages) {
      return true;
    } else {
      let pageSize = this.pageSize;
      let writePage = this.commands.writePage;
      let typeFlash = this.commands.typeFlash;
      let sizeBytes = translator.storeAsTwoBytes(pageSize);
      let payload = dataObj.getPage(pageNum);

      if (payload.length < 1) {
        this.stopProgramming();
      } else if (payload < pageSize) {
        payload = this.pad(payload);
      }

      let data = new Data([writePage, sizeBytes[0], sizeBytes[1], typeFlash]);
      data.addHex(payload);

      this.serial.send(data).then( function () {
        board.writePage(pageNum + 1, dataObj);
      });
    }
  }

  pad (payload) {
    while (payload.length % this.pageSize !== 0) {
      payload.push(0);
    }
    return payload;
  }

  readPageHandler (args) {
    let hexData = translator.binToHex2(args.data);
    let pages = this.pages;
    console.log('Got: ' + hexData);
    pages.push(hexData);
    if (pages.length >= this.totalPages) {
      let data = [].concat.apply([], pages);
      let sketch = translator.binToHex(data);
      console.log('sketch : ', sketch);
      this.downloadCallback(sketch);
      this.stopProgramming();
    }
  }

  defaultHandler () {
    console.log('Basic response handler called.');
  };

  setAddressTo (bitNum) {
    let self = this;
    let pageNum = (pageNum - 1) * this.pageSize;
    return new Promise( function (resolve) {
      let setAddress = self.commands.setAddress;
      var addressBytes = translator.storeAsTwoBytes(bitNum);
      let data = new Data([setAddress, addressBytes[1], addressBytes[0]]);
      self.serial.send(data).then( function (res) {
        resolve(res);
      });
    });
  }

  kickBootloaderConnect () {
    var bitrate = this.bootloaderBitrate;
    var dataBitrate = this.dataBitrate;
    var serial = this.serial;
    var id = serial.connection.id;

    return new Promise( function (resolve) {
      // bootloader wont be kicked if already connected
      serial.disconnect(id).then( function (status) {
        if (status) {

          // the idiomatic way of starting bootlaoder mode is to connect with a bitrate of 1200, and then disconnect
          // that's just how it is
          serial.connect(bitrate).then( function (connection) {
            serial.disconnect(connection.connectionId).then( function (status2) {
              if (!status2) {
                throw new Error('Could not disconnect so could not kick bootloader');
              } else {
                // the bootloader needs 2 seconds to get ready
                setTimeout(function() {
                  console.log('Reconnecting...');
                  serial.connect(dataBitrate).then( function () {
                    resolve(true);
                  });
                }, 2000);
              }
            });
          });
        }
      });
    });
  }

  startProgramming () {
    let board = this;
    return new Promise( function (resolve) {
      board.kickBootloaderConnect().then( function () {
        console.log('kick bootloader')
        board.enterProgrammingMode().then( function (success2) {
          console.log('enter programming mode')
          if (success2) {
            resolve(true);
          }
        }).catch( function (fail2) {
          throw new Error('Could not enter programming mode : ' + fail2);
        });
      });
    });
  }

  enterProgrammingMode () {
    let serial = this.serial;
    let data = new Data(this.commands.enterProgrammingMode, 'hex');
    console.log('programming mode', this.commands.enterProgrammingMode);
    console.log('DATA',data);
    return serial.send(data);
  }

  stopProgramming () {
    let board = this;
    this.exitBootloader().then( function () {
      board.leaveProgrammingMode().then( function () {
        board.serialListener = board.defaultHandler.bind(board);
        board.pages = [];
      });
    });
  }

  exitBootloader () {
    let serial = this.serial;
    let data = new Data(this.commands.exitBootloader);
    return serial.send(data);
  }

  leaveProgrammingMode () {
    let serial = this.serial;
    let data = new Data(this.commands.leaveProgrammingMode);
    return serial.send(data);
  }

  listenToDevice () {
    this.serialListener = this.readDispatcher.bind(this);
    this.serial.listen(this.serialListener);
    return true;
  }

  getConnection (serial) {
    var connection = serial.connection;
    if (connection) {
      return connection;
    } else {
      throw new Error('Avr109 must be passed a valid connection.');
    }
  }
}

export default Avr109;
