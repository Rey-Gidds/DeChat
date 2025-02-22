const express = require('express');
const path = require('path')
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const { Socket } = require('dgram');
const io = new Server(server)

const rooms = {}
const roomColors = {}
const assignedColors = {}
const msg_index = {}
const isBubble = {}
const isReplying = {}

app.use(express.static(path.resolve('./public')))

app.get('/', (req, res) => {
  return res.sendFile('/public/index.html');
});



function assignColors(colors){
    return Math.floor(Math.random()*colors.length)
}

io.on('connection' , user => {
    user.on('joinRoom' , (roomKey) => {
        if(!rooms[roomKey]){
            rooms[roomKey] = {}
            roomColors[roomKey] = ['#00AFFF' , '#F5F5F0' , '#EE6666' , '#FFD700' , '#F2E68F' , '#00FFFF' , '#F87AA3' , '#C5F5CB']
            assignedColors[roomKey] = []
            msg_index[roomKey] = 0
            isBubble[roomKey] = false
            isReplying[roomKey] = {}        
        }
        else if(Object.keys(rooms[roomKey]).length >= 8) {
            user.emit('RoomLimitReached' , 'Cannot Connect room limit reached.')
            return
        }

        
        user.join(roomKey)

        isReplying[roomKey][user.id] = [false , '' , '']

        let index = assignColors(roomColors[roomKey])

        io.to(roomKey).emit('TakeUserId' , user.id)

        rooms[roomKey][user.id] = roomColors[roomKey][index]


        if(index === roomColors[roomKey].length - 1){
            assignedColors[roomKey].push(roomColors[roomKey].pop())
        }
        else{
            let temp = roomColors[roomKey][index]
            roomColors[roomKey][index] = roomColors[roomKey][roomColors[roomKey].length - 1]
            roomColors[roomKey][roomColors[roomKey].length - 1] = temp
            assignedColors[roomKey].push(roomColors[roomKey].pop())
        }
        
        console.log(assignedColors)

        io.to(roomKey).emit('addMemberBall' , assignedColors[roomKey])

        console.log(roomColors , roomColors[roomKey].length)
        
        
        console.log('A Dechatter just Slid in.')

        user.on('editMsg' , (msg_index_for_edit , msg) => {
            let userColor = rooms[roomKey][user.id]
            io.to(roomKey).emit('msgEdited' , { msg , userColor } , user.id , msg_index_for_edit)
        })

        user.on('typing' , () => {
            let userColor = rooms[roomKey][user.id]
            let activeBubble = isBubble[roomKey]
            io.to(roomKey).emit('addtypingball' , userColor , activeBubble)
            isBubble[roomKey] = true
        })

        user.on('stoppedTyping' , () => {
            let userColor = rooms[roomKey][user.id]
            io.to(roomKey).emit('removetypingBall' , userColor)
        })

        user.on('updateBubbleFlag' , (value) => {
            isBubble[roomKey] = value
        })

        user.on('send_message' , (msg) => {
            let userColor = rooms[roomKey][user.id]
            let flag = isReplying[roomKey][user.id][0]
            let rmsg = isReplying[roomKey][user.id][1]
            let rcolor = isReplying[roomKey][user.id][2]
            console.log('Sender: ' , user.id)
            msg_index[roomKey]++
            io.to(roomKey).emit('message' , { msg , userColor } , user.id , msg_index[roomKey] , flag , rmsg , rcolor)
        })

        user.on('deleteMsg' , (msgToDel) => {
            io.to(roomKey).emit('delfromChatBox' , msgToDel)
        })

        user.on('update_reply_flag' , (flag , rmsg , rcolor) => {
            isReplying[roomKey][user.id][0] = flag
            isReplying[roomKey][user.id][1] = rmsg
            isReplying[roomKey][user.id][2] = rcolor
            console.log(isReplying[roomKey])
        })

        user.on('disconnect' , () => {

            console.log('User Disconnected.')

            let userColor = rooms[roomKey][user.id]

            io.to(roomKey).emit('userDisconnected')

            io.to(roomKey).emit('removeMemberColorBall' , userColor)

            assignedColors[roomKey] = assignedColors[roomKey].filter((assignedColor) => { return assignedColor != userColor })

            console.log('Disconnected: ' , assignedColors[roomKey])

            roomColors[roomKey].push(userColor)

            delete rooms[roomKey][user.id]

            if(Object.keys(rooms[roomKey]).length === 0 || assignedColors[roomKey].length === 0){
                delete roomColors[roomKey]
                delete assignedColors[roomKey]
                delete rooms[roomKey]
                delete isBubble[roomKey]
                delete msg_index[roomKey]
                delete isReplying[roomKey]
            }
            console.log(isBubble)
        })
    })
})



const PORT = process.env.PORT || 3000;
server.listen(PORT , () => {
    console.log(`Server started at PORT: ${PORT}`);
});
